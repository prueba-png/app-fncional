/**
 * Protocolo de intercambio de ficheros entre el asistente LLM y el editor.
 * El modelo devuelve los ficheros modificados como:
 *
 *   <file path="index.html">
 *   ...contenido completo...
 *   </file>
 *
 * y, para eliminar un fichero: <delete path="old.css" />
 */
import type { FileMap } from "./types";

export interface ParsedFileChanges {
  updated: FileMap;
  deleted: string[];
  /** Texto explicativo sin los bloques de ficheros */
  prose: string;
  /** Hay un bloque <file> abierto sin cerrar (respuesta truncada o en curso) */
  incomplete: boolean;
}

const FILE_RE = /<file\s+path="([^"]+)"\s*>\r?\n?([\s\S]*?)\r?\n?<\/file>/g;
const DELETE_RE = /<delete\s+path="([^"]+)"\s*\/>/g;

export function sanitizePath(path: string): string | null {
  const clean = path.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
  if (!clean || clean.length > 200) return null;
  if (clean.split("/").some((seg) => seg === ".." || seg === "." || seg === "")) return null;
  if (!/^[\w\-./ ]+$/.test(clean)) return null;
  return clean;
}

/** Quita un posible cercado markdown que el modelo haya añadido dentro del bloque. */
function stripFence(content: string): string {
  const m = content.match(/^\s*```[\w-]*\r?\n([\s\S]*?)\r?\n```\s*$/);
  return m ? m[1] : content;
}

export function parseFileBlocks(text: string): ParsedFileChanges {
  const updated: FileMap = {};
  const deleted: string[] = [];
  for (const m of text.matchAll(FILE_RE)) {
    const p = sanitizePath(m[1]);
    if (p) updated[p] = stripFence(m[2]);
  }
  for (const m of text.matchAll(DELETE_RE)) {
    const p = sanitizePath(m[1]);
    if (p) deleted.push(p);
  }
  const withoutClosed = text.replace(FILE_RE, "").replace(DELETE_RE, "");
  const openIdx = withoutClosed.search(/<file\s+path="/);
  const incomplete = openIdx !== -1;
  const prose = (incomplete ? withoutClosed.slice(0, openIdx) : withoutClosed).replace(/\n{3,}/g, "\n\n").trim();
  return { updated, deleted, prose, incomplete };
}

/** Sustituye los bloques de ficheros por marcadores legibles (para el historial del chat). */
export function summarizeFileBlocks(text: string): string {
  return text
    .replace(FILE_RE, (_m, p: string) => `[fichero actualizado: ${p}]`)
    .replace(DELETE_RE, (_m, p: string) => `[fichero eliminado: ${p}]`)
    .replace(/<file\s+path="([^"]+)"[\s\S]*$/, (_m, p: string) => `[fichero en curso: ${p}]`)
    .trim();
}

const EMBEDDED_DATA_URI_RE = /data:[a-z0-9.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/gi;
/** Por debajo de este tamaño no merece la pena omitir el dato (el marcador ocuparía casi lo mismo) */
const MIN_OMIT_LEN = 300;

/**
 * Imágenes o fuentes incrustadas como data: URL DENTRO de un fichero de texto (p. ej. un @font-face con
 * la fuente en base64, o un fondo incrustado en CSS) pueden pesar cientos de miles de caracteres sin que
 * el asistente necesite verlas para aplicar un cambio de texto, color o maquetación. Se sustituyen por un
 * marcador corto antes de enviarlas, y `restoreDataUris` las repone después si el fichero vuelve sin tocar
 * esa parte, para no perder el dato real aunque la IA solo haya visto el marcador.
 */
export function omitLargeDataUris(files: FileMap): { files: FileMap; restore: Map<string, string> } {
  const restore = new Map<string, string>();
  const out: FileMap = {};
  let n = 0;
  for (const [path, content] of Object.entries(files)) {
    // Un fichero que ES por completo una data: URL (un recorte guardado como su propio fichero) ya se
    // trata aparte en otro punto del código; aquí solo interesan las incrustadas a mitad de un fichero de texto.
    if (/^data:[a-z0-9.+-]+\/[\w.+-]+;base64,/i.test(content)) {
      out[path] = content;
      continue;
    }
    out[path] = content.replace(EMBEDDED_DATA_URI_RE, (uri) => {
      if (uri.length < MIN_OMIT_LEN) return uri;
      const marker = `data:text/x-omitted;id,${++n}`;
      restore.set(marker, uri);
      return marker;
    });
  }
  return { files: out, restore };
}

/** Repone en `files` los datos reales que `omitLargeDataUris` sustituyó por marcadores, si siguen presentes. */
export function restoreDataUris(files: FileMap, restore: Map<string, string>): FileMap {
  if (!restore.size) return files;
  const out: FileMap = {};
  for (const [path, content] of Object.entries(files)) {
    let next = content;
    for (const [marker, real] of restore) if (next.includes(marker)) next = next.split(marker).join(real);
    out[path] = next;
  }
  return out;
}
