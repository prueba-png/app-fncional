/**
 * Limpia una clave de API pegada desde otra app (notas, mensajes…): quita espacios y saltos de línea
 * en los bordes y en medio, y también caracteres invisibles que algunos teclados o apps de notas cuelan
 * sin que se note (espacio de ancho cero, marcas de dirección de texto, uniones invisibles). Una clave
 * con uno de estos caracteres parece idéntica a simple vista pero no es un carácter válido de la clave,
 * así que antes fallaba la validación de forma intermitente y difícil de explicar para quien la copiaba.
 */
export function sanitizeKey(raw: string): string {
  return raw
    .trim()
    .replace(/[​-‏⁠﻿­]/g, "")
    .replace(/\s+/g, "");
}

export function uid(prefix = ""): string {
  const rnd = crypto.getRandomValues(new Uint8Array(10));
  return prefix + Array.from(rnd, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 16);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

const rtf = new Intl.RelativeTimeFormat("es", { numeric: "auto" });
export function timeAgo(ts: number): string {
  const diff = (ts - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
  return new Date(ts).toLocaleDateString("es");
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function slugify(s: string): string {
  return (
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "proyecto"
  );
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) binary += String.fromCharCode(...buf.subarray(i, i + chunk));
  return btoa(binary);
}

export function dataUrlParts(dataUrl: string): { mediaType: string; data: string } {
  const m = dataUrl.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/);
  if (!m) throw new Error("Data URL no válida");
  return { mediaType: m[1], data: m[2] };
}

/**
 * ¿Se puede «continuar» esta respuesta en vez de repetirla entera? Solo cuando el fallo fue por
 * corte de conexión, truncado por longitud o el usuario pulsó «Detener»: en esos casos el código ya
 * generado sigue siendo válido y solo falta terminarlo.
 */
export function canResume(error?: string): boolean {
  if (!error) return false;
  return /se cortó|conexión|incompleto|truncó|truncó por longitud|detenida por el usuario|quedó a medias/i.test(error);
}

/** Instrucción para retomar una respuesta cortada sin rehacer lo que ya se generó bien. */
export function resumePrompt(originalPrompt: string): string {
  return `Se cortó tu respuesta anterior a media generación. Continúa exactamente desde donde la dejaste, completando solo lo que falta o quedó a medias. No repitas ni vuelvas a escribir los ficheros que ya quedaron completos y correctos; deja su contenido igual. Petición original, por si la necesitas de referencia: ${originalPrompt}`;
}

export function languageOf(path: string): "html" | "css" | "javascript" | "json" | "markdown" | "text" {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["html", "htm", "svg", "xml"].includes(ext)) return "html";
  if (["css", "scss"].includes(ext)) return "css";
  if (["js", "mjs", "jsx", "ts", "tsx"].includes(ext)) return "javascript";
  if (ext === "json") return "json";
  if (["md", "markdown"].includes(ext)) return "markdown";
  return "text";
}
