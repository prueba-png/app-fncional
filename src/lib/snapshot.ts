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

/** Pinta los ficheros del proyecto al tamaño indicado y devuelve una imagen JPEG (data URL). */
export function renderSnapshot(files: FileMap, viewport: { width: number; height: number }, opts: { timeoutMs?: number; maxWidth?: number } = {}): Promise<string> {
  const { timeoutMs = 25_000, maxWidth = 1000 } = opts;
  const id = Math.random().toString(36).slice(2);
  const doc = buildPreviewDocument(files, { bridge: false });
  const script = captureScript(id, viewport.height, maxWidth);
  const html = /<\/body>/i.test(doc) ? doc.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${script}</body>`) : doc + script;

  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
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
      if (typeof e.data.dataUrl === "string" && e.data.dataUrl.startsWith("data:image/")) resolve(e.data.dataUrl);
      else reject(new Error(e.data.error || "No se pudo capturar la vista previa"));
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
