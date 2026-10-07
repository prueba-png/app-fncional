/**
 * Construye el documento HTML autocontenido que se renderiza en el iframe
 * sandbox: incrusta CSS/JS locales, resuelve assets de texto (SVG, JSON),
 * inyecta dependencias detectadas y un puente de consola hacia el editor.
 */
import type { FileMap } from "../../shared/types";
import { detectDependencies, getDependencyTags, injectTags } from "../../shared/dependencies";

export const BRIDGE_FLAG = "__devstudio";

const MIME: Record<string, string> = {
  svg: "image/svg+xml",
  json: "application/json",
  txt: "text/plain",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  html: "text/html",
  xml: "application/xml",
  md: "text/markdown",
};

export function resolveLocalPath(ref: string, fromPage: string, files: FileMap): string | null {
  const clean = ref.trim().split("#")[0].split("?")[0];
  if (!clean || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(clean)) return null; // URL absoluta o con esquema
  const dir = fromPage.includes("/") ? fromPage.slice(0, fromPage.lastIndexOf("/") + 1) : "";
  let path: string;
  try {
    path = decodeURIComponent(new URL(clean, `http://project.local/${clean.startsWith("/") ? "" : dir}`).pathname.slice(1));
  } catch {
    return null;
  }
  return path in files ? path : null;
}

function toDataUrl(path: string, content: string): string {
  if (/^data:[a-z]+\/[\w.+-]+;base64,/i.test(content)) return content; // imagen guardada como data URL (recortes de capturas)
  const ext = path.split(".").pop()?.toLowerCase() ?? "txt";
  const mime = MIME[ext] ?? "text/plain";
  return `data:${mime};charset=utf-8,${encodeURIComponent(content)}`;
}

const escapeForTag = (content: string, tag: "script" | "style") => content.replace(new RegExp(`</${tag}`, "gi"), `<\\/${tag}`);

/** Script inyectado en el iframe: reenvía consola/errores y navegación entre páginas locales. */
function bridgeScript(pages: string[], baseOrigin?: string): string {
  return `<script>(function(){
  var F=${JSON.stringify(BRIDGE_FLAG)}, pages=${JSON.stringify(pages)}, baseOrigin=${JSON.stringify(baseOrigin ?? "")};
  function ser(v){try{if(v instanceof Error)return v.name+': '+v.message;if(typeof v==='object'&&v!==null){var s=JSON.stringify(v,null,1);return s&&s.length>2000?s.slice(0,2000)+'…':s}return String(v)}catch(e){return String(v)}}
  function send(level,args){try{parent.postMessage({flag:F,type:'console',level:level,args:Array.prototype.map.call(args,ser)},'*')}catch(e){}}
  ['log','info','warn','error','debug'].forEach(function(l){var o=console[l];console[l]=function(){send(l,arguments);return o&&o.apply(console,arguments)}});
  window.addEventListener('error',function(e){send('error',[e.message+(e.lineno?' (línea '+e.lineno+')':'')])});
  window.addEventListener('unhandledrejection',function(e){send('error',['Promesa rechazada: '+ser(e.reason)])});
  document.addEventListener('click',function(e){
    var a=e.target&&e.target.closest?e.target.closest('a[href]'):null; if(!a)return;
    var href=a.getAttribute('href')||'';
    if(/^#/.test(href)){e.preventDefault();var id=decodeURIComponent(href.slice(1));var t=id&&(document.getElementById(id)||document.getElementsByName(id)[0]);if(t)t.scrollIntoView({behavior:'smooth'});else if(!id||id==='top')window.scrollTo({top:0,behavior:'smooth'});return;}
    if(/^https?:\\/\\//i.test(href)||/^\\/\\//.test(href)){
      // Un enlace absoluto a la MISMA web que se clonó (p. ej. su <base> resuelve "/ofertas" como
      // "https://sitio.com/ofertas") no es un enlace externo de verdad: es otra página de ese sitio que
      // este clon (de una sola página) no tiene. Sacar de la vista previa a la web real no es lo que
      // se pidió, así que se trata igual que un enlace local que no existe, en vez de abrirlo fuera.
      var sameSiteAsOriginal=false;
      try { sameSiteAsOriginal = !!baseOrigin && (a.protocol+'//'+a.host)===baseOrigin; } catch(e) {}
      if(sameSiteAsOriginal){e.preventDefault();send('warn',['Esta web clonada es de una sola página: '+href+' no está incluido en el proyecto.']);return;}
      e.preventDefault();window.open(a.href,'_blank','noopener');return;
    }
    var clean=href.split('#')[0].split('?')[0].replace(/^\\.\\//,'').replace(/^\\//,'');
    if(pages.indexOf(clean)!==-1){e.preventDefault();parent.postMessage({flag:F,type:'navigate',path:clean},'*');}
    else if(!/^[a-z]+:/i.test(href)&&!/^\\/\\//.test(href)){e.preventDefault();send('warn',['Enlace local no encontrado en el proyecto: '+href]);}
  },true);
})();</script>`;
}

/**
 * El iframe de la vista previa usa `sandbox="allow-scripts"` SIN `allow-same-origin` (para que el
 * código de la web clonada no pueda tocar el almacenamiento del editor, donde viven las claves de la
 * IA). Pero eso hace que el propio navegador lance un error al leer `localStorage`/`sessionStorage`
 * ("Storage is disabled inside 'sandboxed' iframes"), y muchas webs reales llaman a eso nada más
 * arrancar (ajustes, analítica, flags...): si no se captura, el script entero se detiene ahí y en
 * pantalla solo queda lo que hubiera estático (a veces, literalmente el aviso de "activa JavaScript").
 * Este script se inyecta el primero de todos y sustituye el almacenamiento (y, por la misma razón,
 * `document.cookie`) por uno en memoria (que se pierde al recargar, pero no rompe nada) solo cuando
 * el real no es accesible; si funciona, no toca nada.
 */
function storagePolyfillScript(): string {
  return `<script>(function(){
  function fake(){
    var mem = {};
    var obj = {
      getItem: function(k){ return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
      setItem: function(k, v){ mem[String(k)] = String(v); },
      removeItem: function(k){ delete mem[String(k)]; },
      clear: function(){ mem = {}; },
      key: function(i){ return Object.keys(mem)[i] || null; },
    };
    Object.defineProperty(obj, "length", { get: function(){ return Object.keys(mem).length; } });
    return obj;
  }
  function patch(name){
    try { var s = window[name]; s.setItem("__t","1"); s.removeItem("__t"); return; } catch(e) {}
    try { Object.defineProperty(window, name, { value: fake(), configurable: true }); } catch(e) {}
  }
  patch("localStorage");
  patch("sessionStorage");
  // Lo mismo le pasa a document.cookie (muchas webs lo leen nada más arrancar: consentimiento de
  // cookies, analítica, sesión...): también lanza un error en vez de devolver una cadena vacía.
  (function(){
    try { var c = document.cookie; document.cookie = "__t=1"; return; } catch(e) {}
    var jar = "";
    try {
      Object.defineProperty(document, "cookie", {
        configurable: true,
        get: function(){ return jar; },
        set: function(v){ var pair = String(v).split(";")[0]; jar = jar ? jar + "; " + pair : pair; },
      });
    } catch(e) {}
  })();
})();</script>`;
}

export interface BuildOptions {
  page?: string;
  autoInjectDeps?: boolean;
  bridge?: boolean;
  /** Clones de webs: dirección original, para que los scripts carguen sus recursos como en la web real */
  baseUrl?: string;
}

export function findEntry(files: FileMap): string | null {
  if ("index.html" in files) return "index.html";
  return Object.keys(files).find((p) => /\.html?$/i.test(p)) ?? null;
}

/** HTML autocontenido del proyecto (todo en un solo fichero) para alojarlo en Netlify, GitHub Pages, etc. */
export function buildStandaloneHtml(files: FileMap, page?: string): string {
  return buildPreviewDocument(files, { page, bridge: false, autoInjectDeps: true });
}

export function buildPreviewDocument(files: FileMap, opts: BuildOptions = {}): string {
  const { autoInjectDeps = true, bridge = true } = opts;
  const page = opts.page && opts.page in files ? opts.page : findEntry(files);
  const pages = Object.keys(files).filter((p) => /\.html?$/i.test(p));

  let html: string;
  if (!page) {
    // Proyecto sin HTML: se crea un documento que carga todo el CSS y JS.
    const css = Object.entries(files).filter(([p]) => p.endsWith(".css")).map(([, c]) => `<style>${escapeForTag(c, "style")}</style>`);
    const js = Object.entries(files).filter(([p]) => /\.m?js$/.test(p)).map(([, c]) => `<script>${escapeForTag(c, "script")}</script>`);
    html = `<!doctype html><html><head><meta charset="utf-8">${css.join("")}</head><body>${js.join("")}</body></html>`;
  } else {
    html = files[page];
    const from = page;

    // <link rel="stylesheet" href="local.css"> → <style>
    // url(recurso-local) dentro del CSS → data URL (las rutas son relativas a la hoja de estilos)
    const inlineCssUrls = (css: string, cssPath: string) =>
      css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q: string, ref: string) => {
        const local = resolveLocalPath(ref, cssPath, files);
        return local && !/\.(css|html?)$/i.test(local) ? `url(${q}${toDataUrl(local, files[local])}${q})` : m;
      });
    html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, open: string, css: string, close: string) => open + inlineCssUrls(css, from) + close);
    html = html.replace(/\bstyle\s*=\s*"([^"]*url\([^"]*)"/gi, (_m, css: string) => `style="${inlineCssUrls(css.replace(/&quot;/g, "'"), from)}"`);

    html = html.replace(/<link\b[^>]*>/gi, (tag) => {
      if (!/rel\s*=\s*["']?[^"'>]*stylesheet/i.test(tag)) return tag;
      const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
      const local = href ? resolveLocalPath(href, from, files) : null;
      if (!local) return tag;
      const media = tag.match(/media\s*=\s*["']([^"']+)["']/i)?.[1];
      return `<style data-file="${local}"${media ? ` media="${media}"` : ""}>\n${escapeForTag(inlineCssUrls(files[local], local), "style")}\n</style>`;
    });

    // <script src="local.js"></script> → <script>
    html = html.replace(/<script\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (tag, pre: string, src: string, post: string) => {
      const local = resolveLocalPath(src, from, files);
      if (!local) return tag;
      const attrs = `${pre} ${post}`.replace(/\s+(?:defer|async)\b/gi, "").trim();
      return `<script data-file="${local}"${attrs ? " " + attrs : ""}>\n${escapeForTag(files[local], "script")}\n</script>`;
    });

    // Otros assets locales de texto (img src="logo.svg", etc.) → data URL
    html = html.replace(/\b(src|href|poster|data)\s*=\s*(["'])([^"']+)\2/gi, (m, attr: string, q: string, ref: string) => {
      const local = resolveLocalPath(ref, from, files);
      if (!local || /\.html?$/i.test(local)) return m;
      return `${attr}=${q}${toDataUrl(local, files[local])}${q}`;
    });
  }

  {
    const storageScript = storagePolyfillScript();
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => `${m}\n${storageScript}`);
    else if (/<html[^>]*>/i.test(html)) html = html.replace(/<html[^>]*>/i, (m) => `${m}<head>${storageScript}</head>`);
    else html = storageScript + html;
  }

  if (autoInjectDeps) {
    const missing = detectDependencies(files).filter((d) => !d.included);
    const head: string[] = [];
    const body: string[] = [];
    for (const d of missing) {
      const tags = getDependencyTags(d.id, files);
      head.push(...tags.head);
      body.push(...tags.body);
    }
    if (head.length || body.length) html = injectTags(html, head, body);
  }

  if (opts.baseUrl) {
    const baseTag = `<base href="${opts.baseUrl.replace(/"/g, "&quot;")}">`;
    html = html.replace(/<base\b[^>]*>/gi, "");
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => `${m}\n${baseTag}`);
    else html = baseTag + html;
  }

  if (bridge) {
    let baseOrigin: string | undefined;
    if (opts.baseUrl) {
      try {
        baseOrigin = new URL(opts.baseUrl).origin;
      } catch {
        /* baseUrl no es una URL válida: se ignora */
      }
    }
    const script = bridgeScript(pages, baseOrigin);
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => `${m}\n${script}`);
    else if (/<html[^>]*>/i.test(html)) html = html.replace(/<html[^>]*>/i, (m) => `${m}<head>${script}</head>`);
    else html = script + html;
  }
  if (!/^\s*<!doctype/i.test(html)) html = `<!doctype html>\n${html}`;
  return html;
}
