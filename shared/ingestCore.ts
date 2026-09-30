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

async function fetchStylesheet(
  fetcher: TextFetcher,
  url: string,
  depth: number,
  warnings: string[],
  budget: { count: number; deadline: number },
): Promise<string> {
  const remaining = budget.deadline - Date.now();
  if (remaining < 500) {
    warnings.push(`No dio tiempo a descargar ${url}.`);
    return `/* omitido (tiempo): ${url} */`;
  }
  if (budget.count >= MAX_STYLESHEETS) {
    warnings.push(`Se alcanzó el máximo de ${MAX_STYLESHEETS} hojas de estilo; ${url} no se incrustó.`);
    return `/* omitido (límite): ${url} */`;
  }
  budget.count++;
  try {
    const res = await fetcher(url, { maxBytes: MAX_CSS_BYTES, accept: "text/css,*/*;q=0.1", timeoutMs: Math.min(12000, remaining) });
    if (res.status >= 400) {
      warnings.push(`La hoja ${url} respondió ${res.status}.`);
      return `/* error ${res.status}: ${url} */`;
    }
    let css = rewriteCssUrls(res.text, res.finalUrl);
    if (depth < MAX_IMPORT_DEPTH) {
      const imports = [...css.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)['"]?\s*\)?([^;]*);/gi)];
      for (const m of imports) {
        const media = m[2].trim();
        const importUrl = absolutize(m[1], res.finalUrl)!;
        if (/fonts\.googleapis\.com/.test(importUrl)) continue; // se conserva el @import de fuentes
        const nested = await fetchStylesheet(fetcher, importUrl, depth + 1, warnings, budget);
        css = css.replace(m[0], media ? `@media ${media} {\n${nested}\n}` : nested);
      }
    }
    return css;
  } catch (err) {
    warnings.push(`No se pudo descargar ${url}: ${(err as Error).message}`);
    return `/* no disponible: ${url} */`;
  }
}

function formatHtml(html: string): string {
  // Normalización ligera: elimina líneas vacías múltiples conservando el contenido original.
  return html.replace(/\n\s*\n\s*\n+/g, "\n\n").trim() + "\n";
}

export async function ingestWithFetcher(fetcher: TextFetcher, opts: IngestOptions): Promise<IngestResult> {
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
    $el.attr("style", rewriteCssUrls($el.attr("style")!, base));
  });

  // --- hojas de estilo: extracción a styles.css ---
  // Las hojas externas se descargan en paralelo y se ensamblan en el orden original del documento
  const budget = { count: 0, deadline: deadline - 500 };
  const styleNodes = $('link[rel~="stylesheet"], style').toArray();
  const partPromises: Array<Promise<string>> = [];
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
      partPromises.push(fetchStylesheet(fetcher, href, 0, warnings, budget).then((css) => wrap(href, css)));
      $el.remove();
    }
  }
  const cssParts = await Promise.all(partPromises);
  const stylesCss = cssParts.join("\n\n");
  for (const m of stylesCss.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) addAsset(m[1], "css url()");

  // --- scripts ---
  let scriptsNote = "";
  if (!keepScripts) {
    const count = $("script").length;
    $("script").each((_, el) => {
      const type = ($(el).attr("type") ?? "").toLowerCase();
      if (type === "application/ld+json") return; // datos estructurados, inofensivos
      $(el).remove();
    });
    $("noscript").each((_, el) => {
      $(el).replaceWith($(el).html() ?? "");
    });
    // Manejadores inline on*
    $("*").each((_, el) => {
      for (const name of Object.keys((el as Element).attribs ?? {})) if (/^on/i.test(name)) $(el).removeAttr(name);
    });
    $('a[href^="javascript:"]').attr("href", "#");
    scriptsNote = `// Se eliminaron ${count} scripts de la página original para su estudio estático.\n// Añade aquí la lógica de tu prototipo.\n`;
  }
  $('meta[http-equiv="Content-Security-Policy" i], meta[http-equiv="refresh" i]').remove();
  $("link[rel=preload], link[rel=modulepreload], link[rel=prefetch], link[rel=dns-prefetch], link[rel=preconnect]").remove();

  // Referencias a los ficheros del proyecto
  const head = $("head").length ? $("head") : $("html").prepend("<head></head>").find("head");
  if (!$('meta[charset]').length) head.prepend('<meta charset="utf-8">');
  head.append('\n<link rel="stylesheet" href="styles.css">\n');
  $("body").append('\n<script src="script.js"></script>\n');

  const files: FileMap = {
    "index.html": formatHtml(`<!-- Réplica de estudio generada por DevStudio Pro a partir de ${res.finalUrl} -->\n` + $.html()),
    "styles.css": `/* Estilos extraídos de ${res.finalUrl} — ${new Date().toISOString()} */\n\n${stylesCss}\n`,
    "script.js": keepScripts ? "// Los scripts originales se conservan en index.html.\n" : scriptsNote,
  };

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
  };
}
