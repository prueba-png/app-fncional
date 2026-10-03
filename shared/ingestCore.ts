/**
 * Motor de clonado de páginas: a partir del HTML de una página pública genera
 * una réplica fiel (index.html + styles.css + script.js) y un informe (DOM,
 * estilos, assets, accesibilidad). La descarga se inyecta (`TextFetcher`): el
 * servidor descarga directamente y el navegador usa un servicio de reenvío.
 */
import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import type { AssetRef, FileMap, IngestOptions, IngestResult } from "./types";
import { detectDependencies } from "./dependencies";
import { analyzeCss, assetKind, auditAccessibility, computeDomStats, detectClientRendered, extractOutline } from "./analysis";

export interface FetchedText {
  finalUrl: string;
  status: number;
  contentType: string;
  text: string;
}
/** Descarga un recurso como texto. Lanza un error si no se puede obtener. */
export type TextFetcher = (url: string, opts: { accept: string; timeoutMs: number; maxBytes: number }) => Promise<FetchedText>;
/** Descarga un recurso binario (fuentes) y lo devuelve en base64. */
export type BinaryFetcher = (url: string, opts: { timeoutMs: number; maxBytes: number }) => Promise<{ contentType: string; base64: string }>;

const MAX_FONTS = 12;
const MAX_FONT_BYTES = 1.5 * 1024 * 1024;
const MAX_FONTS_TOTAL = 5 * 1024 * 1024;
const FONT_MIME: Record<string, string> = { woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf" };

/**
 * Incrusta como data: URL las fuentes de los @font-face. Muchas webs no permiten usar sus fuentes
 * desde otro dominio, así que sin esto el clon se vería con otra tipografía.
 */
export async function inlineFonts(css: string, fetchBinary: BinaryFetcher, warnings: string[], deadline: number): Promise<string> {
  const urls = new Set<string>();
  for (const block of css.match(/@font-face\s*\{[^}]*\}/gi) ?? []) {
    for (const m of block.matchAll(/url\(\s*(['"]?)(https?:[^'")]+)\1\s*\)/gi)) {
      if (/\.(woff2?|ttf|otf)(\?|#|$)/i.test(m[2])) urls.add(m[2]);
    }
  }
  // Primero woff2 (más ligero); se limita el número y el tamaño total
  const list = [...urls].sort((a, b) => Number(!/\.woff2/i.test(a)) - Number(!/\.woff2/i.test(b))).slice(0, MAX_FONTS);
  let total = 0;
  const results = await Promise.all(
    list.map(async (url) => {
      const remaining = deadline - Date.now();
      if (remaining < 800) return null;
      try {
        const res = await fetchBinary(url, { timeoutMs: Math.min(10_000, remaining), maxBytes: MAX_FONT_BYTES });
        return { url, ...res };
      } catch {
        return null;
      }
    }),
  );
  let out = css;
  let skipped = 0;
  for (const r of results) {
    if (!r) {
      skipped++;
      continue;
    }
    const bytes = Math.floor((r.base64.length * 3) / 4);
    if (total + bytes > MAX_FONTS_TOTAL) {
      skipped++;
      continue;
    }
    total += bytes;
    const ext = r.url.split(/[?#]/)[0].split(".").pop()!.toLowerCase();
    const mime = /font|octet/.test(r.contentType) && !/octet/.test(r.contentType) ? r.contentType.split(";")[0] : FONT_MIME[ext] ?? "font/woff2";
    out = out.split(r.url).join(`data:${mime};base64,${r.base64}`);
  }
  if (skipped) warnings.push(`${skipped} fuente(s) no se pudieron copiar; se verán con una tipografía parecida.`);
  return out;
}

const MAX_IMAGES = 30;
const IMAGE_CONCURRENCY = 5;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_IMAGES_TOTAL = 15 * 1024 * 1024;
const IMG_MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

function extFromUrl(url: string): string | null {
  return url.split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? null;
}

function slugFromUrl(url: string): string {
  try {
    const base = new URL(url).pathname.split("/").filter(Boolean).pop() || "img";
    return base.replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9-_]+/gi, "-").slice(0, 40) || "img";
  } catch {
    return "img";
  }
}

/** Ejecuta `fn` sobre `items` con un máximo de `limit` a la vez (no satura los servicios de reenvío). */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Descarga las imágenes reales de la página (fotos, logotipos, iconos) y las guarda como ficheros propios
 * del proyecto en vez de dejarlas enlazadas a la web original: así el clon no depende de que esa web siga
 * en línea, ni de que permita cargar sus imágenes desde otro dominio (muchas lo bloquean por referer/CORS,
 * lo que antes dejaba huecos de imagen rota en el clon aunque todo lo demás se hubiera copiado bien).
 */
async function inlineImages(
  $: cheerio.CheerioAPI,
  stylesCss: string,
  assets: Map<string, AssetRef>,
  fetchBinary: BinaryFetcher,
  warnings: string[],
  deadline: number,
): Promise<{ css: string; files: FileMap }> {
  const candidates = [...assets.values()].filter((a) => (a.kind === "image" || a.kind === "icon") && !/^data:/i.test(a.url)).slice(0, MAX_IMAGES);
  const results = await mapWithConcurrency(candidates, IMAGE_CONCURRENCY, async ({ url }) => {
    const remaining = deadline - Date.now();
    if (remaining < 600) return null;
    try {
      const res = await fetchBinary(url, { timeoutMs: Math.min(10_000, remaining), maxBytes: MAX_IMAGE_BYTES });
      return { url, ...res };
    } catch {
      return null;
    }
  });

  const files: FileMap = {};
  const localFor = new Map<string, string>();
  const used = new Set<string>();
  let total = 0;
  let skipped = 0;
  for (const r of results) {
    if (!r) {
      skipped++;
      continue;
    }
    const bytes = Math.floor((r.base64.length * 3) / 4);
    if (total + bytes > MAX_IMAGES_TOTAL) {
      skipped++;
      continue;
    }
    total += bytes;
    const contentType = r.contentType.split(";")[0].trim().toLowerCase();
    const ext = IMG_MIME_EXT[contentType] ?? extFromUrl(r.url) ?? "jpg";
    const slug = slugFromUrl(r.url);
    let path = `assets/${slug}.${ext}`;
    for (let i = 2; used.has(path); i++) path = `assets/${slug}-${i}.${ext}`;
    used.add(path);
    files[path] = `data:${contentType || `image/${ext}`};base64,${r.base64}`;
    localFor.set(r.url, path);
  }
  if (skipped) warnings.push(`${skipped} imagen(es) no se pudieron descargar; se mantienen enlazadas a la web original.`);

  let css = stylesCss;
  for (const [url, path] of localFor) css = css.split(url).join(path);

  $("[style]").each((_, el) => {
    const $el = $(el);
    const style = $el.attr("style");
    if (!style || !/url\(/i.test(style)) return;
    let next = style;
    for (const [url, path] of localFor) next = next.split(url).join(path);
    if (next !== style) $el.attr("style", next);
  });
  $("img[src], video[poster]").each((_, el) => {
    const $el = $(el);
    for (const attr of ["src", "poster"]) {
      const v = $el.attr(attr);
      if (v && localFor.has(v)) $el.attr(attr, localFor.get(v)!);
    }
  });
  $("[srcset]").each((_, el) => {
    const $el = $(el);
    const value = $el.attr("srcset");
    if (!value) return;
    $el.attr(
      "srcset",
      value
        .split(",")
        .map((part) => {
          const [u, ...desc] = part.trim().split(/\s+/);
          return [localFor.get(u) ?? u, ...desc].join(" ");
        })
        .join(", "),
    );
  });
  $('link[rel*="icon"][href], use[href], image[href]').each((_, el) => {
    const $el = $(el);
    const v = $el.attr("href");
    if (v && localFor.has(v)) $el.attr("href", localFor.get(v)!);
  });

  return { css, files };
}

const MAX_STYLESHEETS = 15;
const MAX_IMPORT_DEPTH = 2;
const MAX_CSS_BYTES = 2 * 1024 * 1024;

function absolutize(ref: string | undefined, base: string): string | undefined {
  if (!ref) return ref;
  const trimmed = ref.trim();
  if (!trimmed || /^(data:|blob:|javascript:|mailto:|tel:|#|about:)/i.test(trimmed)) return trimmed;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return trimmed;
  }
}

function rewriteSrcset(srcset: string, base: string): string {
  return srcset
    .split(",")
    .map((part) => {
      const [u, ...desc] = part.trim().split(/\s+/);
      return [absolutize(u, base), ...desc].join(" ");
    })
    .join(", ");
}

/** Reescribe url(...) relativos dentro de CSS a absolutos respecto a `base`. */
export function rewriteCssUrls(css: string, base: string): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (_m, q: string, u: string) => `url(${q}${absolutize(u, base)}${q})`);
}

/**
 * Descarga una hoja de estilos. `ok: false` significa que no se pudo incrustar: en ese caso el
 * clon conserva el <link> original, que el navegador sí puede cargar directamente desde la web.
 */
async function fetchStylesheetResult(
  fetcher: TextFetcher,
  url: string,
  depth: number,
  warnings: string[],
  budget: { count: number; deadline: number },
): Promise<{ ok: boolean; css: string }> {
  const remaining = budget.deadline - Date.now();
  if (remaining < 500) return { ok: false, css: "" };
  if (budget.count >= MAX_STYLESHEETS) return { ok: false, css: "" };
  budget.count++;
  try {
    const res = await fetcher(url, { maxBytes: MAX_CSS_BYTES, accept: "text/css,*/*;q=0.1", timeoutMs: Math.min(12000, remaining) });
    if (res.status >= 400) {
      warnings.push(`La hoja ${url} respondió ${res.status}.`);
      return { ok: false, css: "" };
    }
    // Un servicio de reenvío puede devolver su propia página o JSON de error en lugar del CSS
    const head = res.text.trim();
    if (/^(<!doctype|<html)/i.test(head)) return { ok: false, css: "" };
    if (head.length < 1200 && /^[[{]/.test(head) && /"?(error|message)"?\s*[:=]/i.test(head) && /api[\s_-]?key|required|invalid|quota|rate.?limit|forbidden|unauthor|blocked|get one at/i.test(head))
      return { ok: false, css: "" };
    let css = rewriteCssUrls(res.text, res.finalUrl).replace(/@import\s+(['"])([^'"]+)\1/gi, (_m, q: string, u: string) => `@import ${q}${absolutize(u, res.finalUrl)}${q}`);
    if (depth < MAX_IMPORT_DEPTH) {
      const imports = [...css.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)['"]?\s*\)?([^;]*);/gi)];
      for (const m of imports) {
        const media = m[2].trim();
        const importUrl = absolutize(m[1], res.finalUrl)!;
        if (/fonts\.googleapis\.com/.test(importUrl)) continue; // se conserva el @import de fuentes
        const nested = await fetchStylesheetResult(fetcher, importUrl, depth + 1, warnings, budget);
        if (!nested.ok) continue; // se conserva el @import original (ya con URL absoluta)
        css = css.replace(m[0], media ? `@media ${media} {\n${nested.css}\n}` : nested.css);
      }
    }
    return { ok: true, css };
  } catch {
    return { ok: false, css: "" };
  }
}

/** Solo en la versión sin scripts: contenidos con animación de entrada que dependen de JavaScript */
const STATIC_FIXES = `
/* ── Ganx: la versión sin scripts muestra los elementos que se animan al hacer scroll ── */
[data-aos], [data-sal], .wow, .aos-init, [data-scroll-reveal], .reveal, .js-reveal, [data-animate] { opacity: 1 !important; transform: none !important; visibility: visible !important; }
`;

const COOKIE_BANNER_SELECTORS = [
  "#onetrust-banner-sdk", "#onetrust-consent-sdk", ".onetrust-pc-dark-filter",
  "#CybotCookiebotDialog", "#CybotCookiebotDialogBodyUnderlay",
  "#qc-cmp2-container", "#didomi-host", ".didomi-popup-backdrop", ".didomi-consent-popup-backdrop",
  "#usercentrics-root", "uc-banner", "uc-app-container", "#cookie-law-info-bar", "#cookie-law-info-again",
  "#cky-consent-container", "#cky-overlay", ".cky-consent-bar",
  "#cmplz-cookiebanner-container", ".cmplz-cookiebanner",
  "#iubenda-cs-banner", ".iubenda-cs-container",
  "#truste-consent-track", "#trustarc-banner-overlay",
  "#borlabs-cookie-box", "#sp_message_container",
  ".cc-window", ".cc-banner", "#cookieconsent",
  "#termly-consent-banner", "#teconsent",
  ".osano-cm-window", ".osano-cm-dialog",
  "#klaro", ".klaro .cookie-notice",
  "#tarteaucitronRoot", "#tarteaucitronAlertBig",
  "#ch2", ".ch2-dialog",
  "#ccc", ".ccc-notify", "#ccc-module",
  "#axeptio_overlay", ".axeptio_widget",
  "#fc-consent-root", ".fc-dialog-container",
  "[class*=cookie-consent-banner]", "[id*=cookie-consent]", "[class*=cookiebanner]",
];
// Scripts de plataformas de gestión de consentimiento (CMP): aunque el aviso visible no se reconozca y
// no se quite, quitar también su script evita que intente hacer cosas (avisar a su propio servidor,
// recargar la página, aplicar sus propias clases) que en una copia independiente fallan a medias y dejan
// la página a medio aplicar sus estilos — el "formulario destructurado" que puede verse al pulsar su botón.
const COOKIE_SCRIPT_RE =
  /cdn\.cookielaw\.org|onetrust|cookiebot|cookie-script\.com|quantcast\.mgr\.consensu\.org|didomi\.io|usercentrics\.eu|cookie-law-info|cmplz|iubenda\.com\/cs|trustarc\.com|borlabs-cookie|cookieyes\.com|cky-|termly\.io|osano\.com|klaro-?js|tarteaucitron\.js|cookiehub\.net|civicuk\.com|cookiecontrol|axeptio\.net|fundingchoicesmessages\.google\.com|consent\.cookiebot|sourcepoint\.(mgr\.consensu\.org|com)/i;
const COOKIE_WORD_RE = /\bcookies?\b/i;
const CONSENT_BUTTON_RE = /\b(aceptar|rechazar|acepto|permitir|configurar|preferencias|manage|accept all|reject all|i agree|allow all|settings)\b/i;

/**
 * Quita el aviso de cookies que tapa el resto de la página y, si usa una plataforma de consentimiento
 * conocida, también su script: como se descarga el HTML sin ejecutar nada (una visita anónima de verdad
 * vería lo mismo), el clon se queda con el aviso encima tal cual lo vería un visitante que nunca ha
 * aceptado nada, y como son scripts pensados para la web original, no para una copia independiente, su
 * botón de aceptar/rechazar puede dejar la página a medias si se intenta usar. No hay forma de "pulsar
 * Aceptar" en una descarga sin navegador, así que se quita el aviso entero del propio HTML.
 */
function removeCookieBanners($: cheerio.CheerioAPI, warnings: string[]): void {
  let removed = 0;
  for (const sel of COOKIE_BANNER_SELECTORS) {
    const el = $(sel);
    if (el.length) {
      el.remove();
      removed++;
    }
  }
  $("script[src]").each((_, el) => {
    if (COOKIE_SCRIPT_RE.test($(el).attr("src") ?? "")) {
      $(el).remove();
      removed++;
    }
  });
  // Heurística genérica (avisos hechos a medida, sin usar un proveedor conocido): un elemento con la
  // palabra "cookie(s)" y al menos un botón típico de aceptar/rechazar/configurar. Se busca tanto en
  // contenedores con pinta de aviso/modal como, más en general, entre los primeros hijos de <body> (así
  // se cubren avisos propios sin esas clases, que son la mayoría de los hechos a medida).
  const candidates = new Set<Element>();
  $('[role="dialog"], [aria-modal="true"], [class*=modal], [class*=overlay], [class*=popup], [class*=banner], [id*=modal], [id*=overlay], [id*=popup], [id*=banner], [class*=consent], [id*=consent]').each(
    (_, el) => {
      candidates.add(el);
    },
  );
  $("body")
    .children()
    .slice(0, 6)
    .each((_, el) => {
      candidates.add(el);
    });
  for (const el of candidates) {
    const $el = $(el);
    if (!$el.parent().length) continue; // ya se quitó como descendiente de otro quitado antes
    if ($el.find("article, main, h1").length) continue; // parece contenido real de la página, no un aviso
    const text = $el.text();
    if (!COOKIE_WORD_RE.test(text) || text.length > 1500) continue; // un aviso de cookies es corto
    const hasButton = $el.find("button, a, input[type=button]").toArray().some((b) => CONSENT_BUTTON_RE.test($(b).text()));
    if (hasButton) {
      $el.remove();
      removed++;
    }
  }
  if (removed) {
    // Los avisos de cookies suelen bloquear el scroll del fondo mientras están abiertos; se revierte.
    for (const sel of ["html", "body"]) {
      const el = $(sel);
      const style = (el.attr("style") ?? "").replace(/overflow\s*:\s*hidden\s*;?/gi, "");
      if (style !== (el.attr("style") ?? "")) el.attr("style", style);
    }
    warnings.push(`Se quitó ${removed > 1 ? `un aviso de cookies (${removed} elementos)` : "un aviso de cookies"} que tapaba el contenido real de la página.`);
  }
}

function formatHtml(html: string): string {
  // Normalización ligera: elimina líneas vacías múltiples conservando el contenido original.
  return html.replace(/\n\s*\n\s*\n+/g, "\n\n").trim() + "\n";
}

export async function ingestWithFetcher(fetcher: TextFetcher, opts: IngestOptions, fetchBinary?: BinaryFetcher): Promise<IngestResult> {
  const { keepScripts = false, inlineStylesheets = true, budgetMs = 60_000 } = opts;
  const deadline = Date.now() + budgetMs;
  const warnings: string[] = [];
  const res = await fetcher(opts.url, {
    accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
    timeoutMs: Math.min(15_000, Math.round(budgetMs * 0.6)),
    maxBytes: 8 * 1024 * 1024,
  });
  if (res.status >= 400) warnings.push(`La página respondió con estado HTTP ${res.status}.`);
  if (res.contentType && !/html|xml/i.test(res.contentType)) warnings.push(`Tipo de contenido inesperado: ${res.contentType}.`);

  const base0 = res.finalUrl;
  const $ = cheerio.load(res.text);
  const baseHref = $("base[href]").attr("href");
  const base = baseHref ? absolutize(baseHref, base0)! : base0;
  $("base").remove();
  removeCookieBanners($, warnings);

  // --- análisis sobre el documento original ---
  const a11y = auditAccessibility($);
  const dom = computeDomStats($);
  const outline = extractOutline($);
  const title = $("title").first().text().trim();
  const description = $('meta[name="description"]').attr("content")?.trim() ?? $('meta[property="og:description"]').attr("content")?.trim() ?? "";
  const lang = $("html").attr("lang") ?? "";
  const looksClientRendered = detectClientRendered($);

  // --- inventario de assets y URLs absolutas ---
  const assets = new Map<string, AssetRef>();
  const addAsset = (url: string | undefined, origin: string, kind?: AssetRef["kind"]) => {
    if (!url || /^(data:|blob:|javascript:|#|mailto:|tel:)/i.test(url)) return;
    if (!assets.has(url) && assets.size < 1000) assets.set(url, { url, origin, kind: assetKind(url, kind) });
  };

  // Imágenes con carga diferida: se promueve data-src a src para que se rendericen
  $("img[data-src], source[data-src]").each((_, el) => {
    const $el = $(el);
    if (!$el.attr("src") || /^data:image\/(gif|svg)/.test($el.attr("src") ?? "")) $el.attr("src", $el.attr("data-src")!);
  });
  for (const attr of ["data-lazy-src", "data-original", "data-lazy", "data-url", "data-img", "data-image"]) {
    $(`img[${attr}]`).each((_, el) => {
      const $el = $(el);
      const v = $el.attr(attr)!;
      if (/\.(png|jpe?g|webp|gif|svg|avif)(\?|#|$)|^https?:|^\//i.test(v) && (!$el.attr("src") || /^data:image\/(gif|svg)|placeholder|blank|spacer|lazy/i.test($el.attr("src")!))) $el.attr("src", v);
    });
  }
  $("[data-bg], [data-background], [data-background-image], [data-bg-src]").each((_, el) => {
    const $el = $(el);
    const v = $el.attr("data-bg") ?? $el.attr("data-background") ?? $el.attr("data-background-image") ?? $el.attr("data-bg-src");
    if (!v || /url\(/i.test($el.attr("style") ?? "")) return;
    const u = v.replace(/^url\(\s*['"]?|['"]?\s*\)$/g, "");
    $el.attr("style", `${$el.attr("style") ? $el.attr("style")!.replace(/;?\s*$/, ";") : ""}background-image:url('${u}')`);
  });
  $("img[data-srcset], source[data-srcset]").each((_, el) => {
    const $el = $(el);
    if (!$el.attr("srcset")) $el.attr("srcset", $el.attr("data-srcset")!);
  });

  const urlAttrs: Array<[string, string, AssetRef["kind"] | undefined]> = [
    ["img", "src", "image"], ["source", "src", "media"], ["video", "src", "media"], ["video", "poster", "image"],
    ["audio", "src", "media"], ["iframe", "src", "other"], ["embed", "src", "other"], ["object", "data", "other"],
    ["script", "src", "script"], ["link", "href", undefined], ["a", "href", undefined], ["form", "action", undefined],
    ["input", "src", "image"], ["image", "href", "image"], ["use", "href", "image"],
  ];
  for (const [tag, attr, kind] of urlAttrs) {
    $(`${tag}[${attr}]`).each((_, el) => {
      const $el = $(el);
      const abs = absolutize($el.attr(attr), base)!;
      $el.attr(attr, abs);
      if (tag === "a" || tag === "form") return;
      if (tag === "link") {
        const rel = ($el.attr("rel") ?? "").toLowerCase();
        if (rel.includes("stylesheet")) addAsset(abs, "link[rel=stylesheet]", "stylesheet");
        else if (rel.includes("icon")) addAsset(abs, `link[rel=${rel}]`, "icon");
        else if (rel.includes("preload") && $el.attr("as") === "font") addAsset(abs, "link[rel=preload]", "font");
        return;
      }
      addAsset(abs, `${tag}[${attr}]`, kind);
    });
  }
  $("[srcset]").each((_, el) => {
    const $el = $(el);
    const rewritten = rewriteSrcset($el.attr("srcset")!, base);
    $el.attr("srcset", rewritten);
    for (const part of rewritten.split(",")) addAsset(part.trim().split(/\s+/)[0], "srcset", "image");
  });
  $("[style]").each((_, el) => {
    const $el = $(el);
    const rewritten = rewriteCssUrls($el.attr("style")!, base);
    $el.attr("style", rewritten);
    for (const m of rewritten.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) addAsset(m[1], "style attr");
  });

  // --- hojas de estilo: extracción a styles.css ---
  // Las hojas externas se descargan en paralelo y se ensamblan en el orden original del documento
  const budget = { count: 0, deadline: deadline - 500 };
  // Carga diferida de CSS («preload» + onload, o media="print" + onload): se convierte en hoja normal
  $('link[rel="preload"][as="style"]').each((_, el) => {
    $(el).attr("rel", "stylesheet").removeAttr("as").removeAttr("onload");
  });
  $('link[rel~="stylesheet"][onload]').each((_, el) => {
    const $el = $(el);
    if (/media/i.test($el.attr("onload")!) && $el.attr("media") === "print") $el.attr("media", "all");
    $el.removeAttr("onload");
  });
  const styleNodes = $('link[rel~="stylesheet"], style').toArray();
  const partPromises: Array<Promise<string>> = [];
  const failedLinks: string[] = [];
  for (const el of styleNodes) {
    const $el = $(el);
    const media = $el.attr("media");
    const wrap = (label: string, css: string) => `/* ── ${label} ── */\n${media && media !== "all" ? `@media ${media} {\n${css}\n}` : css}`;
    if ((el as Element).tagName === "style") {
      partPromises.push(Promise.resolve(wrap("<style> inline", rewriteCssUrls($el.html() ?? "", base))));
      $el.remove();
    } else if (inlineStylesheets) {
      const href = $el.attr("href")!;
      if (/fonts\.googleapis\.com|use\.typekit\.net/.test(href)) continue; // se mantienen como <link>
      partPromises.push(
        fetchStylesheetResult(fetcher, href, 0, warnings, budget).then((r) => {
          if (r.ok) {
            $el.remove();
            return wrap(href, r.css);
          }
          failedLinks.push(href);
          return `/* ── ${href} ── se carga directamente desde la web original (<link> en index.html) */`;
        }),
      );
    }
  }
  const cssParts = await Promise.all(partPromises);
  if (failedLinks.length) warnings.push(`${failedLinks.length} hoja(s) de estilo se cargan directamente desde la web original.`);
  let stylesCss = cssParts.join("\n\n");
  if (fetchBinary && inlineStylesheets) stylesCss = await inlineFonts(stylesCss, fetchBinary, warnings, deadline - 500);
  for (const m of stylesCss.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) addAsset(m[1], "css url()");

  // Imágenes reales (fotos, logotipos, iconos): se descargan y se guardan como ficheros del proyecto en
  // vez de dejarlas enlazadas a la web original (que puede bloquear la carga desde otro dominio o dejar
  // de estar disponible), para que el clon sea una copia de verdad, no una aproximación que depende de
  // que la web original siga sirviendo esas imágenes.
  let imageFiles: FileMap = {};
  if (fetchBinary) {
    const inlined = await inlineImages($, stylesCss, assets, fetchBinary, warnings, deadline - 500);
    stylesCss = inlined.css;
    imageFiles = inlined.files;
  }

  // Sin referrer: muchas webs bloquean sus imágenes si se piden desde otra página
  $('meta[name="referrer" i]').remove();
  const headEl = $("head").length ? $("head") : $("html").prepend("<head></head>").find("head");
  headEl.prepend('<meta name="referrer" content="no-referrer">');
  $('meta[http-equiv="Content-Security-Policy" i], meta[http-equiv="refresh" i], meta[http-equiv="X-Frame-Options" i]').remove();
  $("link[rel=preload]:not([as=style]), link[rel=modulepreload], link[rel=prefetch], link[rel=dns-prefetch], link[rel=preconnect]").remove();
  const snapshot = $.html();

  const build = ($doc: cheerio.CheerioAPI, withScripts: boolean): FileMap => {
    let scriptsNote = "";
    if (!withScripts) {
      const count = $doc("script").length;
      $doc("script").each((_, el) => {
        const type = ($doc(el).attr("type") ?? "").toLowerCase();
        if (type === "application/ld+json") return; // datos estructurados, inofensivos
        $doc(el).remove();
      });
      $doc("noscript").each((_, el) => {
        $doc(el).replaceWith($doc(el).html() ?? "");
      });
      // Manejadores inline on*
      $doc("*").each((_, el) => {
        for (const name of Object.keys((el as Element).attribs ?? {})) if (/^on/i.test(name)) $doc(el).removeAttr(name);
      });
      $doc('a[href^="javascript:"]').attr("href", "#");
      scriptsNote = `// Se eliminaron ${count} scripts de la página original para su estudio estático.\n// Añade aquí la lógica de tu prototipo.\n`;
    }
    const head = $doc("head").length ? $doc("head") : $doc("html").prepend("<head></head>").find("head");
    if (!$doc("meta[charset]").length) head.prepend('<meta charset="utf-8">');
    head.append('\n<link rel="stylesheet" href="styles.css">\n');
    $doc("body").append('\n<script src="script.js"></script>\n');
    return {
      "index.html": formatHtml(`<!-- Réplica de estudio generada por Ganx a partir de ${res.finalUrl} -->\n` + $doc.html()),
      // Sin scripts, los contenidos que aparecen «al hacer scroll» se quedarían invisibles: se muestran
      "styles.css": `/* Estilos extraídos de ${res.finalUrl} — ${new Date().toISOString()} */\n\n${stylesCss}\n${withScripts ? "" : STATIC_FIXES}`,
      "script.js": withScripts ? "// Los scripts originales se conservan en index.html.\n" : scriptsNote,
    };
  };

  const files = { ...build($, keepScripts), ...imageFiles };
  const staticFiles = keepScripts ? { ...build(cheerio.load(snapshot), false), ...imageFiles } : undefined;

  const css = analyzeCss(stylesCss);
  const dependencies = detectDependencies(files);

  return {
    url: opts.url,
    finalUrl: res.finalUrl,
    fetchedAt: new Date().toISOString(),
    title,
    description,
    lang,
    files,
    assets: [...assets.values()],
    outline,
    dom,
    css,
    a11y,
    dependencies,
    warnings,
    looksClientRendered,
    ...(staticFiles ? { staticFiles } : {}),
  };
}
