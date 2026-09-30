/**
 * «Foto» de la página generada, para compararla con la captura original.
 * La página se pinta en un iframe oculto y aislado (solo scripts, origen
 * opaco) con html-to-image, al mismo ancho que la captura, y devuelve un JPEG.
 * El capturador va incluido en la app (no depende de la red del iframe) y no
 * necesita iframes propios, que el aislamiento del origen opaco bloquearía.
 */
import type { FileMap } from "../../shared/types";
import { buildPreviewDocument } from "./bundle";
import htmlToImageSource from "html-to-image/dist/html-to-image.js?raw";

const FLAG = "__devstudio_snapshot";

/** Ancho en píxeles CSS de la pantalla donde se hizo la captura (las de móvil suelen ser a 2x o 3x). */
export function cssViewport(width: number, height: number): { width: number; height: number } {
  const vertical = height > width * 1.3;
  const scale = vertical ? (width >= 1000 ? 3 : width >= 700 ? 2 : 1) : width > 2200 ? 2 : 1;
  const w = Math.max(320, Math.round(width / scale));
  return { width: w, height: Math.round((w * height) / width) };
}

function captureScript(id: string, height: number, maxWidth: number): string {
  return `<script>${htmlToImageSource.replace(/<\/script/gi, "<\\/script")}</script>
<script>
(function () {
  function post(msg) { parent.postMessage(Object.assign({ ${FLAG}: ${JSON.stringify(id)} }, msg), "*"); }
  function background() {
    var els = [document.body, document.documentElement];
    for (var i = 0; i < els.length; i++) {
      var c = els[i] && getComputedStyle(els[i]).backgroundColor;
      if (c && c !== "transparent" && c !== "rgba(0, 0, 0, 0)") return c;
    }
    return "#ffffff";
  }
  function shoot() {
    if (!window.htmlToImage) return post({ error: "capturador no disponible" });
    var w = document.documentElement.clientWidth;
    window.htmlToImage.toJpeg(document.documentElement, {
      quality: 0.82, width: w, height: ${height}, canvasWidth: w, canvasHeight: ${height},
      pixelRatio: Math.min(1, ${maxWidth} / w), backgroundColor: background(),
      imagePlaceholder: "data:image/gif;base64,R0lGODlhAQABAIAAAMzMzAAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==",
      style: { overflow: "hidden", height: "${height}px" }
    }).then(function (dataUrl) { post({ dataUrl: dataUrl }); })
      .catch(function (e) { post({ error: String(e && e.message || e) }); });
  }
  // Se espera a fuentes e imágenes (y un poco a las animaciones de entrada)
  window.addEventListener("load", function () {
    var fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    fonts.then(function () { setTimeout(shoot, 900); });
  });
})();
</script>`;
}

/** Pinta un documento en un iframe oculto y aislado y espera el mensaje que envía el script inyectado. */
function renderInFrame<T>(html: string, id: string, viewport: { width: number; height: number }, timeoutMs: number, accept: (data: Record<string, unknown>) => T): Promise<T> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.tabIndex = -1;
    // Dentro de la ventana (detrás de todo y transparente): Chrome congela los iframes fuera de pantalla
    frame.style.cssText = `position:fixed;left:0;top:0;width:${viewport.width}px;height:${viewport.height}px;border:0;opacity:0.01;pointer-events:none;z-index:-1`;
    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      frame.remove();
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow || !e.data || e.data[FLAG] !== id) return;
      cleanup();
      try {
        resolve(accept(e.data));
      } catch (err) {
        reject(err);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("La vista previa tardó demasiado en pintarse"));
    }, timeoutMs);
    window.addEventListener("message", onMessage);
    frame.srcdoc = html;
    document.body.appendChild(frame);
  });
}

function withScript(doc: string, script: string): string {
  // Función de reemplazo: el script puede contener «$&» o «$'», que replace() interpretaría
  return /<\/body>/i.test(doc) ? doc.replace(/<\/body>(?![\s\S]*<\/body>)/i, () => `${script}</body>`) : doc + script;
}

/** Pinta los ficheros del proyecto al tamaño indicado y devuelve una imagen JPEG (data URL). */
export function renderSnapshot(
  files: FileMap,
  viewport: { width: number; height: number },
  opts: { timeoutMs?: number; maxWidth?: number; baseUrl?: string } = {},
): Promise<string> {
  const { timeoutMs = 30_000, maxWidth = 1000 } = opts;
  const id = Math.random().toString(36).slice(2);
  const html = withScript(buildPreviewDocument(files, { bridge: false, baseUrl: opts.baseUrl }), captureScript(id, viewport.height, maxWidth));
  // El iframe mide lo que una pantalla real de ese ancho (las secciones de «100vh» salen igual que en la captura)
  const screenH = Math.min(viewport.height, viewport.width < 600 ? Math.round(viewport.width * 2.16) : Math.round(viewport.width * 0.625));
  return renderInFrame(html, id, { width: viewport.width, height: screenH }, timeoutMs, (data) => {
    if (typeof data.dataUrl === "string" && data.dataUrl.startsWith("data:image/")) return data.dataUrl;
    throw new Error(String(data.error || "No se pudo capturar la vista previa"));
  });
}

export interface RenderProbe {
  /** Caracteres de texto visibles */
  text: number;
  /** Elementos con tamaño en pantalla */
  visible: number;
  /** Alto de la página */
  height: number;
}

/**
 * Abre la página unos segundos y mide cuánto contenido muestra. Sirve para saber si un clon con los
 * scripts originales se ve bien fuera de su web (si se queda en blanco o se va a otra dirección,
 * devuelve null o muy poco contenido).
 */
export async function probeRender(files: FileMap, opts: { baseUrl?: string; waitMs?: number; timeoutMs?: number; width?: number } = {}): Promise<RenderProbe | null> {
  const { waitMs = 2500, timeoutMs = 15_000, width = 1280 } = opts;
  const id = Math.random().toString(36).slice(2);
  const script = `<script>
(function () {
  var sent = false;
  function report() {
    if (sent) return; sent = true;
    var all = document.body ? document.body.getElementsByTagName("*") : [];
    var visible = 0;
    for (var i = 0; i < all.length && i < 5000; i++) { var r = all[i].getBoundingClientRect(); if (r.width > 2 && r.height > 2) visible++; }
    var text = document.body ? (document.body.innerText || "").replace(/\\s+/g, " ").trim().length : 0;
    parent.postMessage({ ${FLAG}: ${JSON.stringify(id)}, text: text, visible: visible, height: document.documentElement.scrollHeight }, "*");
  }
  window.addEventListener("load", function () { setTimeout(report, ${waitMs}); });
  setTimeout(report, ${waitMs + 6000});
})();
</script>`;
  // Clones de webs: sin añadir librerías, se mide la página tal cual es
  const html = withScript(buildPreviewDocument(files, { bridge: false, baseUrl: opts.baseUrl, autoInjectDeps: false }), script);
  try {
    return await renderInFrame(html, id, { width, height: 800 }, timeoutMs, (d) => ({ text: Number(d.text) || 0, visible: Number(d.visible) || 0, height: Number(d.height) || 0 }));
  } catch {
    return null;
  }
}
