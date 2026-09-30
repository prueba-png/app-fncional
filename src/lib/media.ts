/**
 * Módulo de referencia visual: procesa localmente capturas, vídeos, SVG y PDF
 * para convertirlos en material que el asistente pueda analizar.
 * Todo el procesamiento ocurre en el navegador; nada se sube salvo que el
 * usuario lo envíe explícitamente al asistente.
 */
import type { VisualReference } from "../db/db";
import { uid } from "./util";
import { cssViewport } from "./snapshot";

const MAX_EDGE = 1568; // lado máximo recomendado para visión
const VIDEO_EDGE = 1280;
const MAX_FRAMES = 10;
/** Píxeles por imagen enviada: por encima el modelo la reduce y se pierden los detalles */
const MAX_TILE_PIXELS = 1_150_000;
const MAX_TILES = 10;
const MAX_CANVAS_EDGE = 16_000;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_INPUT_BYTES = 200 * 1024 * 1024;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("No se pudo decodificar la imagen."));
    img.src = src;
  });
}

function readAs(file: Blob, mode: "dataURL" | "text"): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error ?? new Error("Error de lectura"));
    if (mode === "dataURL") r.readAsDataURL(file);
    else r.readAsText(file);
  });
}

function drawScaled(source: CanvasImageSource, w: number, h: number, maxEdge: number) {
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return { canvas, ctx };
}

const toHex = (r: number, g: number, b: number) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");

/** Extrae una paleta dominante mediante cuantización por cubetas + fusión de colores cercanos. */
export function extractPalette(ctx: CanvasRenderingContext2D, w: number, h: number, count = 8): string[] {
  const { data } = ctx.getImageData(0, 0, w, h);
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 40000)));
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 128) continue;
      const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
      const b = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
      b.r += data[i];
      b.g += data[i + 1];
      b.b += data[i + 2];
      b.n++;
      buckets.set(key, b);
    }
  }
  const sorted = [...buckets.values()].sort((a, b) => b.n - a.n).map((b) => [b.r / b.n, b.g / b.n, b.b / b.n] as const);
  const picked: Array<readonly [number, number, number]> = [];
  for (const c of sorted) {
    if (picked.every((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) > 38)) picked.push(c);
    if (picked.length >= count) break;
  }
  return picked.map(([r, g, b]) => toHex(Math.round(r), Math.round(g), Math.round(b)));
}

interface ProcessedImage {
  frame: string;
  palette: string[];
  width: number;
  height: number;
  full: string;
  fullWidth: number;
  fullHeight: number;
  tiles?: Array<{ data: string; y: number; h: number }>;
}

/**
 * Prepara una captura para que la IA la vea con todo detalle:
 * - `frame`: vista general reducida (miniaturas, paleta).
 * - `full`: la captura a buena resolución (hasta 2 píxeles por píxel de pantalla, máx. 1280 de ancho).
 * - `tiles`: si es larga (una página entera), trozos de arriba abajo para que ningún texto quede ilegible.
 */
async function processImage(src: string): Promise<ProcessedImage> {
  const img = await loadImage(src);
  const w = img.naturalWidth || 1024;
  const h = img.naturalHeight || 768;
  const { canvas, ctx } = drawScaled(img, w, h, MAX_EDGE);

  const css = cssViewport(w, h);
  let fullW = Math.min(w, 1280, css.width * 2);
  let fullH = Math.round((fullW * h) / w);
  if (fullH > MAX_CANVAS_EDGE) {
    fullW = Math.max(1, Math.floor((fullW * MAX_CANVAS_EDGE) / fullH));
    fullH = MAX_CANVAS_EDGE;
  }
  let tileH = Math.min(MAX_EDGE, Math.floor(MAX_TILE_PIXELS / fullW));
  if (Math.ceil(fullH / tileH) > MAX_TILES) {
    // Página larguísima: se reduce un poco para no superar el número máximo de trozos
    const k = Math.sqrt((MAX_TILES * tileH) / fullH);
    fullW = Math.max(1, Math.floor(fullW * k));
    fullH = Math.round((fullW * h) / w);
    tileH = Math.min(MAX_EDGE, Math.floor(MAX_TILE_PIXELS / fullW));
  }
  const big = document.createElement("canvas");
  big.width = fullW;
  big.height = fullH;
  const bctx = big.getContext("2d")!;
  bctx.fillStyle = "#ffffff";
  bctx.fillRect(0, 0, fullW, fullH);
  bctx.imageSmoothingQuality = "high";
  bctx.drawImage(img, 0, 0, fullW, fullH);

  let tiles: ProcessedImage["tiles"];
  if (fullH > tileH) {
    tiles = [];
    const overlap = 48;
    for (let y = 0; y < fullH; y += tileH - overlap) {
      const th = Math.min(tileH, fullH - y);
      const t = document.createElement("canvas");
      t.width = fullW;
      t.height = th;
      t.getContext("2d")!.drawImage(big, 0, y, fullW, th, 0, 0, fullW, th);
      tiles.push({ data: t.toDataURL("image/jpeg", 0.88), y, h: th });
      if (y + th >= fullH) break;
    }
  }
  return {
    frame: canvas.toDataURL("image/jpeg", 0.9),
    palette: extractPalette(ctx, canvas.width, canvas.height),
    width: w,
    height: h,
    full: big.toDataURL("image/jpeg", 0.9),
    fullWidth: fullW,
    fullHeight: fullH,
    tiles,
  };
}

function waitEvent(el: HTMLMediaElement, event: string, timeout = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
      reject(new Error("Tiempo de espera agotado al procesar el vídeo."));
    }, timeout);
    const ok = () => {
      cleanup();
      resolve();
    };
    const ko = () => {
      cleanup();
      reject(new Error("El navegador no puede decodificar este vídeo."));
    };
    const cleanup = () => {
      clearTimeout(t);
      el.removeEventListener(event, ok);
      el.removeEventListener("error", ko);
    };
    el.addEventListener(event, ok, { once: true });
    el.addEventListener("error", ko, { once: true });
  });
}

/**
 * Elige los momentos del vídeo en los que la pantalla cambia (scroll, otra página, un menú abierto…)
 * para no perder partes de la interfaz. Si el vídeo apenas cambia, usa momentos equiespaciados.
 */
async function pickDistinctTimes(video: HTMLVideoElement, duration: number, n: number): Promise<number[]> {
  const even = Array.from({ length: n }, (_, i) => (duration * (i + 0.5)) / n);
  const samples = Math.min(48, Math.max(n, Math.round(duration / 0.4)));
  if (samples <= n) return even;
  const sw = 48;
  const sh = Math.max(1, Math.round((sw * (video.videoHeight || 9)) / (video.videoWidth || 16)));
  const c = document.createElement("canvas");
  c.width = sw;
  c.height = sh;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  let last: Uint8ClampedArray | null = null;
  const kept: Array<{ t: number; change: number }> = [];
  const started = Date.now();
  for (let i = 0; i < samples; i++) {
    if (Date.now() - started > 20_000) return even; // vídeo muy lento de decodificar
    const t = (duration * (i + 0.5)) / samples;
    video.currentTime = t;
    await waitEvent(video, "seeked");
    ctx.drawImage(video, 0, 0, sw, sh);
    const data = ctx.getImageData(0, 0, sw, sh).data;
    let diff = 0;
    if (last) {
      for (let p = 0; p < data.length; p += 4) diff += Math.abs(data[p] - last[p]) + Math.abs(data[p + 1] - last[p + 1]) + Math.abs(data[p + 2] - last[p + 2]);
      diff /= (data.length / 4) * 765;
    }
    if (!last || diff > 0.035) {
      kept.push({ t, change: last ? diff : 1 });
      last = new Uint8ClampedArray(data);
    }
  }
  if (kept.length < Math.min(3, n)) return even;
  if (kept.length <= n) return kept.map((k) => k.t);
  // Demasiados cambios: se reparten a lo largo del vídeo, conservando el primero
  return Array.from({ length: n }, (_, i) => kept[Math.round((i * (kept.length - 1)) / (n - 1 || 1))].t);
}

/** Extrae fotogramas de un vídeo local (los momentos en que cambia la pantalla). */
export async function extractVideoFrames(file: Blob, frames = 6, onProgress?: (p: number) => void) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  try {
    await waitEvent(video, "loadeddata");
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const n = Math.min(MAX_FRAMES, Math.max(1, frames));
    const times = duration > 0 ? await pickDistinctTimes(video, duration, n) : [0];
    const out: string[] = [];
    let palette: string[] = [];
    for (let i = 0; i < times.length; i++) {
      video.currentTime = times[i];
      await waitEvent(video, "seeked");
      const { canvas, ctx } = drawScaled(video, video.videoWidth, video.videoHeight, VIDEO_EDGE);
      out.push(canvas.toDataURL("image/jpeg", 0.82));
      if (i === Math.floor(times.length / 2)) palette = extractPalette(ctx, canvas.width, canvas.height);
      onProgress?.((i + 1) / times.length);
    }
    return { frames: out, palette, width: video.videoWidth, height: video.videoHeight, duration };
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute("src");
    video.load();
  }
}

export async function processReferenceFile(
  file: File,
  projectId: string,
  opts: { videoFrames?: number; onProgress?: (p: number) => void } = {},
): Promise<VisualReference> {
  if (file.size > MAX_INPUT_BYTES) throw new Error(`"${file.name}" supera el tamaño máximo de 200 MB.`);
  const base = { id: uid("ref_"), projectId, name: file.name, size: file.size, createdAt: Date.now() };
  const type = file.type || "";
  const lower = file.name.toLowerCase();

  if (type === "image/svg+xml" || lower.endsWith(".svg")) {
    const svgText = await readAs(file, "text");
    const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
    const img = await processImage(src);
    return { ...base, kind: "svg", svgText, frames: [img.frame], palette: img.palette, width: img.width, height: img.height };
  }
  if (type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp|avif)$/.test(lower)) {
    const img = await processImage(await readAs(file, "dataURL"));
    return {
      ...base,
      kind: "image",
      frames: [img.frame],
      palette: img.palette,
      width: img.width,
      height: img.height,
      full: img.full,
      fullWidth: img.fullWidth,
      fullHeight: img.fullHeight,
      tiles: img.tiles,
    };
  }
  if (type.startsWith("video/") || /\.(mp4|webm|mov|m4v|ogv)$/.test(lower)) {
    const v = await extractVideoFrames(file, opts.videoFrames ?? 6, opts.onProgress);
    return { ...base, kind: "video", ...v };
  }
  if (type === "application/pdf" || lower.endsWith(".pdf")) {
    if (file.size > MAX_PDF_BYTES) throw new Error("Los PDF de diseño deben pesar menos de 20 MB.");
    const pdf = await readAs(file, "dataURL");
    return { ...base, kind: "pdf", pdf: pdf.replace(/^data:[^;]*;/, "data:application/pdf;"), frames: [], palette: [] };
  }
  throw new Error(`Formato no soportado: ${file.name}. Usa imágenes, SVG, vídeo o PDF.`);
}
