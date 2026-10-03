/**
 * Gestor de dependencias: detecta librerías front-end comunes a partir del
 * código de un prototipo (HTML/CSS/JS) y proporciona las etiquetas CDN
 * necesarias para renderizarlo localmente.
 */
import type { DetectedDependency, FileMap } from "./types";

export interface DependencyDefinition {
  id: string;
  name: string;
  description: string;
  homepage: string;
  /** Etiquetas a inyectar en <head> */
  headTags: string[];
  /** Etiquetas a inyectar al final de <body> (scripts que dependen del DOM) */
  bodyTags?: string[];
  /** Patrones que indican que la librería ya está incluida */
  includedPatterns: RegExp[];
  /** Señales de uso; cada una suma peso a la confianza */
  signals: Array<{ pattern: RegExp; weight: number; label: string; scope: "html" | "css" | "js" | "any" }>;
  /** Umbral mínimo de confianza para considerarla detectada */
  threshold: number;
  /** Otras dependencias necesarias (se inyectan antes) */
  requires?: string[];
}

const G = "g";

export const DEPENDENCIES: DependencyDefinition[] = [
  {
    id: "tailwind",
    name: "Tailwind CSS (Play CDN)",
    description: "Framework CSS utility-first. El Play CDN compila las clases en el navegador.",
    homepage: "https://tailwindcss.com",
    headTags: ['<script src="https://cdn.tailwindcss.com"></script>'],
    includedPatterns: [/cdn\.tailwindcss\.com/i, /tailwindcss(@[\d.]+)?\/dist/i, /@tailwindcss\/browser/i],
    signals: [
      { pattern: /class(Name)?="[^"]*\b(?:flex|grid)\b[^"]*\b(?:gap|items|justify)-[\w-]+/, weight: 0.4, label: "flex/grid + gap/items/justify", scope: "html" },
      { pattern: /\b(?:bg|text|border)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)\b/, weight: 0.5, label: "colores de paleta Tailwind", scope: "html" },
      { pattern: /\b(?:sm|md|lg|xl|2xl):[a-z-]+/, weight: 0.35, label: "prefijos responsive (md:, lg:)", scope: "html" },
      { pattern: /\b(?:px|py|pt|pb|pl|pr|mx|my|mt|mb|ml|mr)-(?:\d+|\[\w+\])\b/, weight: 0.25, label: "espaciado utility (px-4, mt-2)", scope: "html" },
      { pattern: /\brounded-(?:sm|md|lg|xl|2xl|3xl|full)\b/, weight: 0.2, label: "rounded-*", scope: "html" },
      { pattern: /@tailwind\s+(?:base|components|utilities)|@apply\s/, weight: 0.8, label: "directivas @tailwind/@apply", scope: "css" },
    ],
    threshold: 0.6,
  },
  {
    id: "bootstrap",
    name: "Bootstrap 5",
    description: "Framework CSS con componentes y sistema de rejilla.",
    homepage: "https://getbootstrap.com",
    headTags: ['<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css">'],
    bodyTags: ['<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>'],
    includedPatterns: [/bootstrap(@[\d.]+)?\/dist\/css\/bootstrap/i, /bootstrap(\.min)?\.css/i],
    signals: [
      { pattern: /class="[^"]*\bcol-(?:xs|sm|md|lg|xl|xxl)-\d{1,2}\b/, weight: 0.5, label: "rejilla col-md-*", scope: "html" },
      { pattern: /class="[^"]*\bbtn btn-(?:primary|secondary|success|danger|warning|info|light|dark|outline-\w+)\b/, weight: 0.6, label: "btn btn-*", scope: "html" },
      { pattern: /class="[^"]*\bnavbar-expand(?:-\w+)?\b/, weight: 0.5, label: "navbar-expand", scope: "html" },
      { pattern: /\bdata-bs-(?:toggle|target|dismiss)=/, weight: 0.7, label: "atributos data-bs-*", scope: "html" },
      { pattern: /class="[^"]*\b(?:container-fluid|form-control|form-label|card-body|list-group-item)\b/, weight: 0.4, label: "componentes Bootstrap", scope: "html" },
    ],
    threshold: 0.6,
  },
  {
    id: "bulma",
    name: "Bulma",
    description: "Framework CSS basado en Flexbox.",
    homepage: "https://bulma.io",
    headTags: ['<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bulma@1.0.2/css/bulma.min.css">'],
    includedPatterns: [/bulma(@[\d.]+)?\/css\/bulma/i, /bulma(\.min)?\.css/i],
    signals: [
      { pattern: /class="[^"]*\bis-(?:primary|link|info|success|warning|danger)\b/, weight: 0.4, label: "modificadores is-*", scope: "html" },
      { pattern: /class="[^"]*\b(?:columns|hero-body|navbar-burger|level-left|tile is-ancestor)\b/, weight: 0.5, label: "componentes Bulma", scope: "html" },
    ],
    threshold: 0.7,
  },
  {
    id: "fontawesome",
    name: "Font Awesome 6",
    description: "Iconografía vectorial mediante clases fa-*.",
    homepage: "https://fontawesome.com",
    headTags: ['<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">'],
    includedPatterns: [/font-?awesome/i, /kit\.fontawesome\.com/i],
    signals: [
      { pattern: /class="[^"]*\bfa-(?:solid|regular|brands|light|thin)\b/, weight: 0.9, label: "fa-solid/fa-regular", scope: "html" },
      { pattern: /class="[^"]*\b(?:fas|far|fab|fa) fa-[\w-]+/, weight: 0.9, label: "fas fa-*", scope: "html" },
    ],
    threshold: 0.8,
  },
  {
    id: "bootstrap-icons",
    name: "Bootstrap Icons",
    description: "Iconos oficiales de Bootstrap (clases bi bi-*).",
    homepage: "https://icons.getbootstrap.com",
    headTags: ['<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css">'],
    includedPatterns: [/bootstrap-icons/i],
    signals: [{ pattern: /class="[^"]*\bbi bi-[\w-]+/, weight: 1, label: "bi bi-*", scope: "html" }],
    threshold: 0.8,
  },
  {
    id: "material-symbols",
    name: "Material Symbols",
    description: "Iconos de Google Material (ligaduras de fuente).",
    homepage: "https://fonts.google.com/icons",
    headTags: [
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0">',
      '<link rel="stylesheet" href="https://fonts.googleapis.com/icon?family=Material+Icons">',
    ],
    includedPatterns: [/Material\+(?:Symbols|Icons)/i],
    signals: [{ pattern: /class="[^"]*\bmaterial-(?:icons|symbols-\w+)\b/, weight: 1, label: "material-icons / material-symbols", scope: "html" }],
    threshold: 0.8,
  },
  {
    id: "jquery",
    name: "jQuery 3",
    description: "Librería de manipulación del DOM.",
    homepage: "https://jquery.com",
    headTags: ['<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>'],
    includedPatterns: [/jquery(-[\d.]+)?(\.min)?\.js/i, /code\.jquery\.com/i],
    signals: [
      { pattern: /\$\(\s*(?:document|window|["'`][^"'`]+["'`])\s*\)\s*\.\s*(?:ready|on|click|find|addClass|removeClass|toggleClass|css|hide|show|each)\b/, weight: 0.9, label: "$(...).metodo()", scope: "js" },
      { pattern: /\bjQuery\s*\(/, weight: 0.9, label: "jQuery(...)", scope: "js" },
      { pattern: /\$\.(?:ajax|get|post|getJSON|each|extend)\(/, weight: 0.9, label: "$.ajax/$.get", scope: "js" },
    ],
    threshold: 0.8,
  },
  {
    id: "alpine",
    name: "Alpine.js",
    description: "Reactividad ligera declarada en atributos HTML.",
    homepage: "https://alpinejs.dev",
    headTags: ['<script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.1/dist/cdn.min.js"></script>'],
    includedPatterns: [/alpinejs/i],
    signals: [
      { pattern: /\bx-data(?:=|\s|>)/, weight: 0.9, label: "x-data", scope: "html" },
      { pattern: /\bx-(?:show|if|for|model|bind|on|text|transition)\b/, weight: 0.5, label: "directivas x-*", scope: "html" },
    ],
    threshold: 0.8,
  },
  {
    id: "htmx",
    name: "htmx",
    description: "Interacciones AJAX declarativas mediante atributos hx-*.",
    homepage: "https://htmx.org",
    headTags: ['<script src="https://unpkg.com/htmx.org@2.0.2"></script>'],
    includedPatterns: [/htmx(\.org)?/i],
    signals: [{ pattern: /\bhx-(?:get|post|put|patch|delete|target|swap|trigger)=/, weight: 1, label: "atributos hx-*", scope: "html" }],
    threshold: 0.8,
  },
  {
    id: "gsap",
    name: "GSAP",
    description: "Motor de animación JavaScript.",
    homepage: "https://gsap.com",
    headTags: ['<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script>'],
    includedPatterns: [/gsap(\.min)?\.js/i],
    signals: [{ pattern: /\bgsap\.(?:to|from|fromTo|timeline|set|registerPlugin)\(/, weight: 1, label: "gsap.to/from/timeline", scope: "js" }],
    threshold: 0.8,
  },
  {
    id: "chartjs",
    name: "Chart.js",
    description: "Gráficos en <canvas>.",
    homepage: "https://www.chartjs.org",
    headTags: ['<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>'],
    includedPatterns: [/chart(\.umd)?(\.min)?\.js/i],
    signals: [{ pattern: /\bnew\s+Chart\s*\(/, weight: 1, label: "new Chart(...)", scope: "js" }],
    threshold: 0.8,
  },
  {
    id: "animate-css",
    name: "Animate.css",
    description: "Animaciones CSS predefinidas (animate__*).",
    homepage: "https://animate.style",
    headTags: ['<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/animate.css/4.1.1/animate.min.css">'],
    includedPatterns: [/animate(\.min)?\.css/i],
    signals: [{ pattern: /\banimate__(?:animated|\w+)/, weight: 1, label: "animate__*", scope: "any" }],
    threshold: 0.8,
  },
  {
    id: "aos",
    name: "AOS (Animate On Scroll)",
    description: "Animaciones al hacer scroll mediante data-aos.",
    homepage: "https://michalsnik.github.io/aos/",
    headTags: ['<link rel="stylesheet" href="https://unpkg.com/aos@2.3.4/dist/aos.css">'],
    bodyTags: ['<script src="https://unpkg.com/aos@2.3.4/dist/aos.js"></script>', "<script>window.AOS && AOS.init();</script>"],
    includedPatterns: [/aos(@[\d.]+)?\/dist\/aos/i],
    signals: [{ pattern: /\bdata-aos=/, weight: 1, label: "data-aos", scope: "html" }],
    threshold: 0.8,
  },
  {
    id: "swiper",
    name: "Swiper",
    description: "Carruseles táctiles.",
    homepage: "https://swiperjs.com",
    headTags: ['<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.css">'],
    bodyTags: ['<script src="https://cdn.jsdelivr.net/npm/swiper@11/swiper-bundle.min.js"></script>'],
    includedPatterns: [/swiper(@[\d.]+)?\/swiper-bundle/i],
    signals: [
      { pattern: /class="[^"]*\bswiper(?:-wrapper|-slide)?\b/, weight: 0.6, label: "clases swiper-*", scope: "html" },
      { pattern: /\bnew\s+Swiper\s*\(/, weight: 0.9, label: "new Swiper(...)", scope: "js" },
    ],
    threshold: 0.8,
  },
  {
    id: "lucide",
    name: "Lucide Icons",
    description: "Iconos SVG mediante data-lucide.",
    homepage: "https://lucide.dev",
    headTags: ['<script src="https://unpkg.com/lucide@0.452.0/dist/umd/lucide.min.js"></script>'],
    bodyTags: ["<script>window.lucide && lucide.createIcons();</script>"],
    includedPatterns: [/lucide/i],
    signals: [{ pattern: /\bdata-lucide=/, weight: 1, label: "data-lucide", scope: "html" }],
    threshold: 0.8,
  },
];

/** Fuentes de Google Fonts que se detectan por su font-family */
export const GOOGLE_FONTS = [
  "Inter", "Roboto", "Open Sans", "Lato", "Montserrat", "Poppins", "Raleway", "Nunito", "Nunito Sans",
  "Playfair Display", "Merriweather", "Source Sans 3", "Source Sans Pro", "Work Sans", "Rubik", "DM Sans",
  "Manrope", "Plus Jakarta Sans", "Space Grotesk", "IBM Plex Sans", "IBM Plex Mono", "Fira Sans", "Fira Code",
  "JetBrains Mono", "Outfit", "Karla", "Mulish", "Quicksand", "Barlow", "Oswald", "Noto Sans", "PT Sans",
  "Ubuntu", "Josefin Sans", "Archivo", "Lexend", "Sora", "Figtree", "Geist", "Bebas Neue", "Libre Baskerville",
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function splitSources(files: FileMap): { html: string; css: string; js: string } {
  let html = "";
  let css = "";
  let js = "";
  for (const [path, content] of Object.entries(files)) {
    const lower = path.toLowerCase();
    if (lower.endsWith(".html") || lower.endsWith(".htm")) html += "\n" + content;
    else if (lower.endsWith(".css")) css += "\n" + content;
    else if (/\.(m?js|jsx|ts|tsx)$/.test(lower)) js += "\n" + content;
  }
  // Estilos y scripts inline también cuentan
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) css += "\n" + m[1];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) js += "\n" + m[1];
  return { html, css, js };
}

/** Busca familias tipográficas de Google Fonts referenciadas en el CSS y no cargadas aún. */
export function detectGoogleFonts(css: string, html: string): string[] {
  const found = new Set<string>();
  for (const m of css.matchAll(/font-family\s*:\s*([^;}{]+)/gi)) {
    for (const raw of m[1].split(",")) {
      const fam = raw.trim().replace(/^["']|["']$/g, "");
      const match = GOOGLE_FONTS.find((f) => f.toLowerCase() === fam.toLowerCase());
      if (match) found.add(match);
    }
  }
  return [...found].filter((f) => !new RegExp(`family=${escapeRegExp(f.replace(/ /g, "+"))}`, "i").test(html));
}

export function googleFontsTag(families: string[]): string {
  const q = families.map((f) => `family=${f.replace(/ /g, "+")}:wght@300;400;500;600;700`).join("&");
  return `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${q}&display=swap">`;
}

export function detectDependencies(files: FileMap): DetectedDependency[] {
  const { html, css, js } = splitSources(files);
  const all = `${html}\n${css}\n${js}`;
  const headSection = html; // incluye <link>/<script src>
  const results: DetectedDependency[] = [];

  for (const dep of DEPENDENCIES) {
    const included = dep.includedPatterns.some((p) => {
      // Solo consideramos "incluida" si aparece en un src/href
      const re = new RegExp(`(?:src|href)\\s*=\\s*["'][^"']*${p.source}`, p.flags.replace(G, ""));
      return re.test(headSection);
    });
    let score = 0;
    const evidence: string[] = [];
    for (const s of dep.signals) {
      const target = s.scope === "html" ? html : s.scope === "css" ? css : s.scope === "js" ? js : all;
      if (s.pattern.test(target)) {
        score += s.weight;
        evidence.push(s.label);
      }
    }
    const confidence = Math.min(1, score);
    if (confidence >= dep.threshold || included) {
      results.push({ id: dep.id, name: dep.name, confidence: included ? 1 : confidence, evidence, included });
    }
  }

  const fonts = detectGoogleFonts(css, html);
  if (fonts.length) {
    results.push({
      id: "google-fonts",
      name: `Google Fonts (${fonts.join(", ")})`,
      confidence: 0.9,
      evidence: fonts.map((f) => `font-family: ${f}`),
      included: false,
    });
  }
  return results.sort((a, b) => Number(a.included) - Number(b.included) || b.confidence - a.confidence);
}

export function getDependencyTags(id: string, files: FileMap): { head: string[]; body: string[] } {
  if (id === "google-fonts") {
    const { css, html } = splitSources(files);
    const fonts = detectGoogleFonts(css, html);
    return { head: fonts.length ? [googleFontsTag(fonts)] : [], body: [] };
  }
  const def = DEPENDENCIES.find((d) => d.id === id);
  if (!def) return { head: [], body: [] };
  return { head: def.headTags, body: def.bodyTags ?? [] };
}

/** Inserta etiquetas en <head> y antes de </body>. Si no hay <head>/<body>, las antepone/añade. */
export function injectTags(html: string, head: string[], body: string[]): string {
  let out = html;
  if (head.length) {
    const block = head.map((t) => `    ${t}`).join("\n");
    if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, `${block}\n  </head>`);
    else if (/<body[^>]*>/i.test(out)) out = out.replace(/<body[^>]*>/i, (m) => `<head>\n${block}\n</head>\n${m}`);
    else out = `${block}\n${out}`;
  }
  if (body.length) {
    const block = body.map((t) => `    ${t}`).join("\n");
    if (/<\/body>/i.test(out)) out = out.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${block}\n  </body>`);
    else out = `${out}\n${block}`;
  }
  return out;
}

/** Añade de forma permanente las dependencias indicadas al HTML principal. */
export function addDependenciesToHtml(html: string, ids: string[], files: FileMap): string {
  const head: string[] = [];
  const body: string[] = [];
  for (const id of ids) {
    const tags = getDependencyTags(id, files);
    head.push(...tags.head);
    body.push(...tags.body);
  }
  return injectTags(html, head, body);
}
