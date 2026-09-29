/**
 * Motor de análisis estructural de UI: a partir del HTML de una página pública
 * genera un informe (estructura DOM, estilos, assets, accesibilidad) y una
 * réplica estática de estudio (index.html + styles.css + script.js).
 */
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import type { A11yIssue, AssetRef, DomStats, FileMap, IngestOptions, IngestResult, OutlineNode } from "../../shared/types";
import { detectDependencies } from "../../shared/dependencies";
import { analyzeCss } from "./cssAnalyzer";
import { decodeBody, safeFetch } from "./safeFetch";

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

function snippet($: cheerio.CheerioAPI, el: AnyNode): string {
  const html = $.html(el) ?? "";
  return html.length > 160 ? html.slice(0, 157) + "..." : html;
}

function accessibleText($: cheerio.CheerioAPI, el: Element): string {
  const $el = $(el);
  return (
    $el.attr("aria-label") ||
    $el.attr("aria-labelledby") ||
    $el.attr("title") ||
    $el.text().trim() ||
    $el.find("img[alt]").attr("alt") ||
    $el.find("svg title").text() ||
    ""
  ).trim();
}

function auditAccessibility($: cheerio.CheerioAPI): A11yIssue[] {
  const issues: A11yIssue[] = [];
  const push = (i: A11yIssue) => issues.length < 300 && issues.push(i);

  if (!$("html").attr("lang")) push({ severity: "error", rule: "html-lang", message: "El elemento <html> no declara el atributo lang." });
  if (!$("title").first().text().trim()) push({ severity: "error", rule: "document-title", message: "El documento no tiene <title>." });

  const viewport = $('meta[name="viewport"]').attr("content");
  if (!viewport) push({ severity: "warning", rule: "meta-viewport", message: "Falta <meta name=\"viewport\">: la página no será responsive en móviles." });
  else if (/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(?:\.0)?\b/i.test(viewport))
    push({ severity: "error", rule: "meta-viewport-zoom", message: "El viewport impide el zoom del usuario (user-scalable=no / maximum-scale=1)." });

  $("img").each((_, el) => {
    if ($(el).attr("alt") === undefined && $(el).attr("role") !== "presentation")
      push({ severity: "error", rule: "image-alt", message: "Imagen sin atributo alt.", snippet: snippet($, el) });
  });

  $("input, select, textarea").each((_, el) => {
    const $el = $(el);
    const type = ($el.attr("type") ?? "").toLowerCase();
    if (["hidden", "submit", "button", "reset", "image"].includes(type)) return;
    const id = $el.attr("id");
    const labelled =
      $el.attr("aria-label") || $el.attr("aria-labelledby") || $el.attr("title") || $el.closest("label").length > 0 ||
      (id && $(`label[for="${id.replace(/"/g, '\\"')}"]`).length > 0);
    if (!labelled) push({ severity: "error", rule: "form-label", message: "Control de formulario sin etiqueta accesible.", snippet: snippet($, el) });
    else if (!$el.attr("aria-label") && !id && $el.attr("placeholder") && !$el.closest("label").length)
      push({ severity: "info", rule: "placeholder-label", message: "El placeholder no sustituye a una etiqueta.", snippet: snippet($, el) });
  });

  $("button, a[href], [role=button]").each((_, el) => {
    if (!accessibleText($, el as Element))
      push({ severity: "error", rule: "control-name", message: "Botón o enlace sin texto accesible.", snippet: snippet($, el) });
  });

  let last = 0;
  const h1 = $("h1").length;
  if (h1 === 0) push({ severity: "warning", rule: "page-has-heading-one", message: "La página no contiene ningún <h1>." });
  if (h1 > 1) push({ severity: "info", rule: "multiple-h1", message: `La página contiene ${h1} elementos <h1>.` });
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const lvl = Number((el as Element).tagName.slice(1));
    if (last && lvl > last + 1)
      push({ severity: "warning", rule: "heading-order", message: `Salto de jerarquía de encabezados: h${last} → h${lvl}.`, snippet: snippet($, el) });
    last = lvl;
  });

  if (!$("main, [role=main]").length) push({ severity: "warning", rule: "landmark-main", message: "No existe landmark <main>." });

  $("[tabindex]").each((_, el) => {
    if (Number($(el).attr("tabindex")) > 0)
      push({ severity: "warning", rule: "tabindex", message: "tabindex positivo altera el orden natural de foco.", snippet: snippet($, el) });
  });

  const ids = new Map<string, number>();
  $("[id]").each((_, el) => {
    const id = $(el).attr("id")!;
    ids.set(id, (ids.get(id) ?? 0) + 1);
  });
  for (const [id, n] of ids) if (n > 1) push({ severity: "warning", rule: "duplicate-id", message: `El id "${id}" está repetido ${n} veces.` });

  return issues;
}

function computeDomStats($: cheerio.CheerioAPI): DomStats {
  const freq = new Map<string, number>();
  let total = 0;
  let maxDepth = 0;
  const walk = (node: AnyNode, depth: number) => {
    if (node.type === "tag" || node.type === "script" || node.type === "style") {
      const el = node as Element;
      total++;
      maxDepth = Math.max(maxDepth, depth);
      freq.set(el.tagName, (freq.get(el.tagName) ?? 0) + 1);
      for (const c of el.children) walk(c, depth + 1);
    }
  };
  const root = $.root().get(0);
  if (root) for (const c of (root as unknown as { children: AnyNode[] }).children) walk(c, 1);

  const landmarkSelectors: Record<string, string> = {
    banner: "header, [role=banner]",
    navigation: "nav, [role=navigation]",
    main: "main, [role=main]",
    complementary: "aside, [role=complementary]",
    contentinfo: "footer, [role=contentinfo]",
    search: "search, [role=search]",
    form: "form[aria-label], form[aria-labelledby], [role=form]",
  };
  return {
    totalElements: total,
    maxDepth,
    tagFrequency: [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([tag, count]) => ({ tag, count })),
    landmarks: Object.entries(landmarkSelectors).map(([role, sel]) => ({ role, count: $(sel).length })).filter((l) => l.count > 0),
    forms: $("form").length,
    inputs: $("input, select, textarea").length,
    links: $("a[href]").length,
    images: $("img, picture, svg").length,
    scripts: $("script").length,
    stylesheets: $('link[rel~="stylesheet"], style').length,
    inlineStyles: $("[style]").length,
  };
}

function extractOutline($: cheerio.CheerioAPI): OutlineNode[] {
  const out: OutlineNode[] = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text && out.length < 150) out.push({ level: Number((el as Element).tagName.slice(1)), text: text.slice(0, 140) });
  });
  return out;
}

function assetKind(url: string, hint?: AssetRef["kind"]): AssetRef["kind"] {
  if (hint) return hint;
  const p = url.split("?")[0].toLowerCase();
  if (/\.(png|jpe?g|gif|webp|avif|svg|bmp)$/.test(p)) return "image";
  if (/\.(woff2?|ttf|otf|eot)$/.test(p)) return "font";
  if (/\.(mp4|webm|ogg|mp3|wav)$/.test(p)) return "media";
  if (p.endsWith(".css")) return "stylesheet";
  if (/\.m?js$/.test(p)) return "script";
  if (p.endsWith(".ico")) return "icon";
  return "other";
}

async function fetchStylesheet(url: string, depth: number, warnings: string[], budget: { count: number }): Promise<string> {
  if (budget.count >= MAX_STYLESHEETS) {
    warnings.push(`Se alcanzó el máximo de ${MAX_STYLESHEETS} hojas de estilo; ${url} no se incrustó.`);
    return `/* omitido (límite): ${url} */`;
  }
  budget.count++;
  try {
    const res = await safeFetch(url, { maxBytes: MAX_CSS_BYTES, accept: "text/css,*/*;q=0.1", timeoutMs: 12000 });
    if (res.status >= 400) {
      warnings.push(`La hoja ${url} respondió ${res.status}.`);
      return `/* error ${res.status}: ${url} */`;
    }
    let css = rewriteCssUrls(decodeBody(res.body, res.contentType), res.finalUrl);
    if (depth < MAX_IMPORT_DEPTH) {
      const imports = [...css.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)['"]?\s*\)?([^;]*);/gi)];
      for (const m of imports) {
        const media = m[2].trim();
        const importUrl = absolutize(m[1], res.finalUrl)!;
        if (/fonts\.googleapis\.com/.test(importUrl)) continue; // se conserva el @import de fuentes
        const nested = await fetchStylesheet(importUrl, depth + 1, warnings, budget);
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

export async function ingestUrl(opts: IngestOptions): Promise<IngestResult> {
  const { keepScripts = false, inlineStylesheets = true } = opts;
  const warnings: string[] = [];
  const res = await safeFetch(opts.url, { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" });
  if (res.status >= 400) warnings.push(`La página respondió con estado HTTP ${res.status}.`);
  if (res.contentType && !/html|xml/i.test(res.contentType)) warnings.push(`Tipo de contenido inesperado: ${res.contentType}.`);

  const base0 = res.finalUrl;
  const $ = cheerio.load(decodeBody(res.body, res.contentType));
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
  const cssParts: string[] = [];
  const budget = { count: 0 };
  const styleNodes = $('link[rel~="stylesheet"], style').toArray();
  for (const el of styleNodes) {
    const $el = $(el);
    if ((el as Element).tagName === "style") {
      const media = $el.attr("media");
      const css = rewriteCssUrls($el.html() ?? "", base);
      cssParts.push(`/* ── <style> inline ── */\n${media && media !== "all" ? `@media ${media} {\n${css}\n}` : css}`);
      $el.remove();
    } else if (inlineStylesheets) {
      const href = $el.attr("href")!;
      if (/fonts\.googleapis\.com|use\.typekit\.net/.test(href)) continue; // se mantienen como <link>
      const media = $el.attr("media");
      const css = await fetchStylesheet(href, 0, warnings, budget);
      cssParts.push(`/* ── ${href} ── */\n${media && media !== "all" ? `@media ${media} {\n${css}\n}` : css}`);
      $el.remove();
    }
  }
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

/** Heurística: la página depende de JavaScript para mostrar su contenido (React, Vue, Next…). */
export function detectClientRendered($: cheerio.CheerioAPI): boolean {
  const body = $("body").clone();
  body.find("script, style, noscript, template, link, meta").remove();
  const text = body.text().replace(/\s+/g, " ").trim();
  const visible = body.find("img, svg, video, picture, canvas, input, button").length;
  const hasScripts = $("script[src], script[type=module]").length > 0;
  const emptyMount = ["#root", "#app", "#__next", "#__nuxt", "#svelte", "[data-reactroot]"].some((sel) => {
    const el = $(sel);
    return el.length > 0 && el.text().trim().length < 20 && el.children().length <= 1;
  });
  // Páginas pequeñas con un script de analítica no cuentan: hace falta un contenedor vacío o un cuerpo prácticamente sin contenido
  return hasScripts && (emptyMount || (text.length < 40 && visible < 2));
}
