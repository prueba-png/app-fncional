import type { ChatAttachment } from "../../shared/types";
import type { VisualReference } from "../db/db";
import { dataUrlParts } from "./util";

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
    r.frames.forEach((f, i) => {
      const { mediaType, data } = dataUrlParts(f);
      attachments.push({
        type: "image",
        mediaType: mediaType as "image/jpeg" | "image/png",
        data,
        label: r.kind === "video" ? `${r.name} · fotograma ${i + 1}/${r.frames.length}` : r.name,
      });
    });
    if (r.palette.length) attachments.push({ type: "text", text: `Paleta dominante de ${r.name}: ${r.palette.join(", ")}` });
  }
  return { attachments, labels };
}

export function countImages(attachments: ChatAttachment[]): number {
  return attachments.filter((a) => a.type === "image").length;
}
