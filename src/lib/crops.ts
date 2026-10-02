/**
 * Recortes reales de la captura: la IA escribe `captura:<id>#x,y,ancho,alto`
 * (o `captura:<id>~N#…` para el fotograma N de un vídeo) donde necesita una
 * foto, un logotipo o un icono de la captura, y aquí se recorta ese trozo de la
 * imagen y se guarda como fichero del proyecto (recortes/…), para que el clon
 * use exactamente las mismas imágenes que el original.
 */
import type { FileMap } from "../../shared/types";
import * as db from "../db/db";

export const CROP_DIR = "recortes/";
const CAPTURE_RE = /captura:(ref_[a-z0-9]+)(?:~(\d+))?#\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/gi;
const TEXT_RE = /\.(html?|css|js|mjs|svg|json)$/i;

export function isDataFile(content: string): boolean {
  return /^data:[a-z]+\/[\w.+-]+;base64,/i.test(content);
}

export function hasCaptureRefs(files: FileMap): boolean {
  return Object.entries(files).some(([p, c]) => TEXT_RE.test(p) && /captura:ref_/i.test(c));
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("imagen no válida"));
    img.src = src;
  });
}

async function crop(src: string, x: number, y: number, w: number, h: number): Promise<string | null> {
  const img = await loadImage(src);
  // La IA calcula estas coordenadas a ojo (puede pasarse por unos píxeles cerca de un borde): se desplaza
  // el recorte lo justo para que el rectángulo pedido quepa entero en la imagen, en vez de truncarlo a casi
  // nada (que es lo que antes producía recortes vacíos y, por tanto, el bloque de color de reserva).
  const cx = Math.max(0, Math.min(x, Math.max(0, img.naturalWidth - w)));
  const cy = Math.max(0, Math.min(y, Math.max(0, img.naturalHeight - h)));
  const cw = Math.min(w, img.naturalWidth - cx);
  const ch = Math.min(h, img.naturalHeight - cy);
  if (cw < 2 || ch < 2) return null;
  const c = document.createElement("canvas");
  c.width = cw;
  c.height = ch;
  c.getContext("2d")!.drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch);
  // Iconos y logotipos pequeños en PNG (bordes nítidos); fotos en JPEG (menos peso)
  return cw * ch <= 90_000 ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.9);
}

/**
 * Sustituye las referencias `captura:` de los ficheros modificados por recortes reales.
 * Devuelve los ficheros a escribir (incluidos los recortes nuevos) y los recortes que ya nadie usa.
 */
export async function resolveCrops(updated: FileMap, current: FileMap, projectId: string): Promise<{ updated: FileMap; deleted: string[] }> {
  if (!hasCaptureRefs(updated)) return { updated, deleted: [] };
  const refs = new Map((await db.listReferences(projectId)).map((r) => [r.id, r]));
  const out: FileMap = { ...updated };
  const made = new Map<string, string | null>(); // clave del recorte → ruta del fichero (o null si no se pudo)

  for (const [path, content] of Object.entries(updated)) {
    if (!TEXT_RE.test(path) || !/captura:ref_/i.test(content)) continue;
    const matches = [...content.matchAll(CAPTURE_RE)];
    for (const m of matches) {
      const [, id, frame, xs, ys, ws, hs] = m;
      const key = `${id}~${frame ?? ""}#${xs},${ys},${ws},${hs}`;
      if (made.has(key)) continue;
      const ref = refs.get(id);
      const src = ref ? (frame !== undefined ? ref.frames[Number(frame)] : (ref.full ?? ref.frames[0])) : undefined;
      let file: string | null = null;
      if (src) {
        try {
          const data = await crop(src, +xs, +ys, +ws, +hs);
          if (data) {
            file = `${CROP_DIR}${id.slice(4, 10)}${frame !== undefined ? `-f${frame}` : ""}-${xs}-${ys}-${ws}x${hs}.${data.startsWith("data:image/png") ? "png" : "jpg"}`;
            out[file] = data;
          }
        } catch {
          file = null;
        }
      }
      made.set(key, file);
    }
    const depth = path.split("/").length - 1;
    out[path] = content.replace(CAPTURE_RE, (_whole, id: string, frame: string | undefined, xs, ys, ws, hs) => {
      const file = made.get(`${id}~${frame ?? ""}#${xs},${ys},${ws},${hs}`);
      // Sin recorte posible: un bloque gris del mismo tamaño para no romper la maquetación
      return file ? "../".repeat(depth) + file : `https://placehold.co/${ws}x${hs}/e5e7eb/e5e7eb`;
    });
  }

  // Recortes que ya no usa ningún fichero (la IA los sustituyó)
  const merged = { ...current, ...out };
  const texts = Object.entries(merged)
    .filter(([p]) => TEXT_RE.test(p))
    .map(([, c]) => c)
    .join("\n");
  const deleted = Object.keys(merged).filter((p) => p.startsWith(CROP_DIR) && !texts.includes(p.slice(CROP_DIR.length)));
  for (const p of deleted) delete out[p];
  return { updated: out, deleted: deleted.filter((p) => p in current) };
}
