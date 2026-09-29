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
