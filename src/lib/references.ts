import type { ChatAttachment } from "../../shared/types";
import type { VisualReference } from "../db/db";
import { dataUrlParts } from "./util";
import { cssViewport } from "./snapshot";

export const MAX_IMAGES_PER_REQUEST = 20;

/** Convierte referencias visuales en adjuntos para el asistente. */
export function referencesToAttachments(refs: VisualReference[]): { attachments: ChatAttachment[]; labels: string[] } {
  const attachments: ChatAttachment[] = [];
  const labels: string[] = [];
  for (const r of refs) {
    labels.push(r.name);
    if (r.kind === "pdf" && r.pdf) {
      attachments.push({ type: "pdf", data: dataUrlParts(r.pdf).data, label: r.name });
      continue;
    }
    if (r.kind === "svg" && r.svgText) attachments.push({ type: "text", text: r.svgText.slice(0, 60_000), label: `${r.name} (SVG)` });
    const image = (dataUrl: string, label: string) => {
      const { mediaType, data } = dataUrlParts(dataUrl);
      attachments.push({ type: "image", mediaType: mediaType as "image/jpeg" | "image/png", data, label });
    };
    const fullW = r.fullWidth ?? 0;
    const fullH = r.fullHeight ?? 0;
    if (r.kind === "image" && r.full && r.tiles?.length) {
      // Captura larga: vista general + trozos a buena resolución, con su posición para poder recortar
      image(r.frames[0], `${r.name} · vista general (reducida)`);
      r.tiles.forEach((t, i) =>
        image(t.data, `${r.name} · parte ${i + 1}/${r.tiles!.length}: píxeles y=${t.y}…${t.y + t.h} de la imagen completa de ${fullW}×${fullH} (id ${r.id})`),
      );
    } else if (r.kind === "image" && r.full) {
      image(r.full, `${r.name} · ${fullW}×${fullH} px (id ${r.id})`);
    } else {
      r.frames.forEach((f, i) => image(f, r.kind === "video" ? `${r.name} · fotograma ${i + 1}/${r.frames.length} (id ${r.id}~${i})` : r.name));
    }
    const facts = [
      r.width && r.height ? `tamaño original ${r.width}×${r.height} px (${r.height > r.width * 1.3 ? "vertical: captura de móvil" : r.width > r.height * 1.3 ? "horizontal: captura de escritorio" : "casi cuadrada"})` : "",
      r.width && r.height ? `ancho de pantalla estimado ${cssViewport(r.width, r.height).width} px CSS` : "",
      r.palette.length ? `paleta dominante ${r.palette.join(", ")}` : "",
      r.kind === "image" && r.full
        ? `para recortar imágenes reales usa captura:${r.id}#x,y,ancho,alto con píxeles de la imagen completa de ${fullW}×${fullH}`
        : r.kind === "video"
          ? `para recortar de un fotograma usa captura:${r.id}~N#x,y,ancho,alto (N = número de fotograma empezando en 0, píxeles del fotograma)`
          : "",
    ].filter(Boolean);
    if (facts.length) attachments.push({ type: "text", text: `Datos de ${r.name}: ${facts.join("; ")}` });
  }
  return { attachments, labels };
}

export function countImages(attachments: ChatAttachment[]): number {
  return attachments.filter((a) => a.type === "image").length;
}

/** Palabras que indican que el usuario se refiere a la(s) captura(s) originales del proyecto. */
const MEMORY_RE = /captur|foto|imagen|im[aá]genes|logo|logotipo|icono|banner|cabecera|original|mand[eé]|envi[eé]|la que te|referenci|mism[oa]s?\s+(logo|imagen|foto|color|icono|banner)/i;
export function refersToOriginal(text: string): boolean {
  return MEMORY_RE.test(text);
}

/**
 * Versión ligera (1 imagen por referencia) para que la IA «recuerde» las capturas originales al editar,
 * sin reenviar todos los trozos. Incluye cómo recortar de ellas (logo, foto, icono) con captura:<id>#…
 */
export function memoryAttachments(refs: VisualReference[]): ChatAttachment[] {
  const out: ChatAttachment[] = [];
  for (const r of refs.slice(0, 6)) {
    const frame = r.full ?? r.frames[0];
    if (!frame) continue;
    const { mediaType, data } = dataUrlParts(frame);
    const w = r.fullWidth ?? r.width ?? 0;
    const h = r.fullHeight ?? r.height ?? 0;
    out.push({
      type: "image",
      mediaType: mediaType as "image/jpeg" | "image/png",
      data,
      label: `Captura original «${r.name}» (para consultar; si necesitas su logo, foto o icono recórtalo de aquí con captura:${r.id}#x,y,ancho,alto en píxeles de la imagen completa de ${w}×${h})`,
    });
  }
  return out;
}
