/**
 * Módulo de referencia visual: procesa localmente capturas, vídeos, SVG y PDF
 * para convertirlos en material que el asistente pueda analizar.
 * Todo el procesamiento ocurre en el navegador; nada se sube salvo que el
 * usuario lo envíe explícitamente al asistente.
 */
import type { VisualReference } from "../db/db";
import { uid } from "./util";

const MAX_EDGE = 1568; // lado máximo recomendado para visión
const VIDEO_EDGE = 1280;
const MAX_FRAMES = 8;
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

async function processImage(src: string): Promise<{ frame: string; palette: string[]; width: number; height: number }> {
  const img = await loadImage(src);
  const w = img.naturalWidth || 1024;
  const h = img.naturalHeight || 768;
  const { canvas, ctx } = drawScaled(img, w, h, MAX_EDGE);
  return {
    frame: canvas.toDataURL("image/jpeg", 0.9),
    palette: extractPalette(ctx, canvas.width, canvas.height),
    width: w,
    height: h,
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

/** Extrae fotogramas equiespaciados de un vídeo local. */
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
    const times = duration > 0 ? Array.from({ length: n }, (_, i) => (duration * (i + 0.5)) / n) : [0];
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
    return { ...base, kind: "image", frames: [img.frame], palette: img.palette, width: img.width, height: img.height };
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
