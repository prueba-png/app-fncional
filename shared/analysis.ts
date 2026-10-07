/**
 * Análisis estructural de una página (DOM, accesibilidad, estilos, assets).
 * Lo usan el servidor (clonado por URL) y el navegador (análisis del proyecto
 * actual, también en la versión de un solo archivo sin servidor).
 */
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import type { A11yIssue, AssetRef, CssStats, DomStats, FileMap, IngestResult, OutlineNode } from "./types";
import { detectDependencies } from "./dependencies";

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

export function auditAccessibility($: cheerio.CheerioAPI): A11yIssue[] {
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

export function computeDomStats($: cheerio.CheerioAPI): DomStats {
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

export function extractOutline($: cheerio.CheerioAPI): OutlineNode[] {
  const out: OutlineNode[] = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text && out.length < 150) out.push({ level: Number((el as Element).tagName.slice(1)), text: text.slice(0, 140) });
  });
  return out;
}

export function assetKind(url: string, hint?: AssetRef["kind"]): AssetRef["kind"] {
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

// Firmas conocidas de las páginas de "reto" que sirven los sistemas antibots más comunes en vez del
// contenido real cuando detectan que la petición no viene de un navegador normal: no son un fallo de esta
// app, es la propia web bloqueando el acceso automático (igual que vería cualquier otra herramienta).
const BOT_CHALLENGE_RE =
  /powered\s+and\s+protected\s+by\s+akamai|challenge[\s-]?validation|checking\s+your\s+browser\s+before\s+accessing|cf-browser-verification|\/cdn-cgi\/challenge-platform\/|just\s+a\s+moment\.{3}|attention\s+required!\s*\|\s*cloudflare|press\s*(&|and)\s*hold|_px-captcha|perimeterx|datadome|geo\.captcha-delivery\.com|request\s+unsuccessful\.\s*incapsula|_incapsula_resource|are\s+you\s+a\s+human/i;

/** Heurística: la respuesta es una página de verificación antibots (Akamai, Cloudflare, PerimeterX…), no el contenido real de la web. */
export function detectBotChallenge($: cheerio.CheerioAPI): boolean {
  const body = $("body").text().replace(/\s+/g, " ").trim();
  const head = $("head").html() ?? "";
  return BOT_CHALLENGE_RE.test(body) || BOT_CHALLENGE_RE.test(head) || BOT_CHALLENGE_RE.test($("title").text());
}

// ── CSS ────────────────────────────────────────────────────────────────────
function topN(map: Map<string, number>, n: number) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([value, count]) => ({ value, count }));
}

function bump(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

const COLOR_RE = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|rgba?\([^)]+\)|hsla?\([^)]+\)|oklch\([^)]+\)/gi;

function normalizeColor(c: string): string {
  const lower = c.toLowerCase().replace(/\s+/g, " ");
  if (/^#[0-9a-f]{3}$/.test(lower)) return "#" + [...lower.slice(1)].map((ch) => ch + ch).join("");
  return lower;
}

export function analyzeCss(css: string): CssStats {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const colors = new Map<string, number>();
  const fonts = new Map<string, number>();
  const sizes = new Map<string, number>();
  const media = new Set<string>();
  const breakpoints = new Set<string>();
  const vars = new Map<string, string>();

  for (const m of withoutComments.matchAll(COLOR_RE)) bump(colors, normalizeColor(m[0]));
  for (const m of withoutComments.matchAll(/font-family\s*:\s*([^;}{]+)/gi)) bump(fonts, m[1].trim().replace(/\s*!important$/, ""));
  for (const m of withoutComments.matchAll(/font-size\s*:\s*([^;}{]+)/gi)) bump(sizes, m[1].trim());
  for (const m of withoutComments.matchAll(/@media\s*([^{]+)\{/gi)) {
    const q = m[1].trim();
    media.add(q);
    for (const b of q.matchAll(/(?:min|max)-width\s*:\s*([\d.]+(?:px|em|rem))/gi)) breakpoints.add(b[1]);
  }
  for (const m of withoutComments.matchAll(/(--[\w-]+)\s*:\s*([^;}{]+)/g)) {
    if (!vars.has(m[1]) && vars.size < 200) vars.set(m[1], m[2].trim());
  }
  const rules = (withoutComments.match(/\{/g) ?? []).length;

  return {
    bytes: new TextEncoder().encode(css).byteLength,
    rules,
    mediaQueries: [...media].slice(0, 50),
    customProperties: [...vars.entries()].map(([name, value]) => ({ name, value })),
    colors: topN(colors, 40),
    fontFamilies: topN(fonts, 15),
    fontSizes: topN(sizes, 20),
    breakpoints: [...breakpoints].sort((a, b) => parseFloat(a) - parseFloat(b)),
  };
}

// ── Análisis del proyecto actual (sin red) ─────────────────────────────────

export type ProjectReport = Omit<IngestResult, "files">;

/** Analiza los ficheros del proyecto (HTML principal + todo el CSS) sin descargar nada. */
export function analyzeProject(files: FileMap, label: string): ProjectReport {
  const entry = "index.html" in files ? "index.html" : Object.keys(files).find((p) => /\.html?$/i.test(p));
  const $ = cheerio.load(entry ? files[entry] : "<html><body></body></html>");
  const cssParts = Object.entries(files)
    .filter(([p]) => p.toLowerCase().endsWith(".css"))
    .map(([, c]) => c);
  $("style").each((_, el) => {
    cssParts.push($(el).html() ?? "");
  });
  const css = cssParts.join("\n");

  const assets = new Map<string, AssetRef>();
  const add = (url: string | undefined, origin: string, kind?: AssetRef["kind"]) => {
    const u = url?.trim();
    if (!u || /^(data:|blob:|javascript:|#|mailto:|tel:)/i.test(u) || assets.size >= 1000 || assets.has(u)) return;
    assets.set(u, { url: u, origin, kind: assetKind(u, kind) });
  };
  $("img[src]").each((_, el) => add($(el).attr("src"), "img[src]", "image"));
  $("script[src]").each((_, el) => add($(el).attr("src"), "script[src]", "script"));
  $("video[src], audio[src], source[src]").each((_, el) => add($(el).attr("src"), "media", "media"));
  $("link[href]").each((_, el) => {
    const rel = ($(el).attr("rel") ?? "").toLowerCase();
    if (rel.includes("stylesheet")) add($(el).attr("href"), "link[rel=stylesheet]", "stylesheet");
    else if (rel.includes("icon")) add($(el).attr("href"), `link[rel=${rel}]`, "icon");
  });
  $("[srcset]").each((_, el) => {
    for (const part of ($(el).attr("srcset") ?? "").split(",")) add(part.trim().split(/\s+/)[0], "srcset", "image");
  });
  for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) add(m[1], "css url()");

  return {
    url: label,
    finalUrl: label,
    fetchedAt: new Date().toISOString(),
    title: $("title").first().text().trim(),
    description: $('meta[name="description"]').attr("content")?.trim() ?? "",
    lang: $("html").attr("lang") ?? "",
    assets: [...assets.values()],
    outline: extractOutline($),
    dom: computeDomStats($),
    css: analyzeCss(css),
    a11y: auditAccessibility($),
    dependencies: detectDependencies(files),
    warnings: entry ? [] : ["El proyecto no tiene ningún fichero HTML."],
    looksClientRendered: false,
    blockedByAntiBot: false,
  };
}
