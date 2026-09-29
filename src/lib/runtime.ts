/**
 * Integración con el visor de claude.ai cuando la app se publica como página
 * web (sin servidor local): `sample` pide respuestas a Claude con la cuenta
 * del propio usuario y `downloads` permite guardar ficheros.
 * Fuera del visor, `window.claude` no existe y todo devuelve null.
 */
import type { ChatAttachment, ChatTurn, FileMap } from "../../shared/types";
import { summarizeFileBlocks } from "../../shared/fileBlocks";
import { REFERENCE_PROMPT, SYSTEM_PROMPT, buildFilesContext } from "../../shared/prompts";
import { downloadBlob } from "./util";

interface SampleTurn {
  role: "user" | "assistant";
  content: string;
}
interface SampleOptions {
  onText?: (u: { text: string; delta: string }) => void;
  signal?: AbortSignal;
  images?: Blob[];
  modelTier?: "default" | "complex" | "quick";
  cache?: boolean;
}
interface SampleLimits {
  maxPromptBytes: number;
  images?: { maxCount: number; maxInputBytes: number; mediaTypes: string[] };
}
export interface SampleFn {
  (input: string | SampleTurn[], opts?: SampleOptions): Promise<{ text: string; truncated: boolean; modelTierApplied: string }>;
  limits(): Promise<SampleLimits>;
}
interface SampleError {
  code: string;
  message: string;
  text?: string;
}
interface Downloads {
  save(req: { filename: string; data: Blob | string }): Promise<{ status: "saved" | "delivered" }>;
}
interface ClaudeRuntime {
  use(name: string): Promise<unknown>;
}

function runtime(): ClaudeRuntime | null {
  if (typeof window === "undefined") return null;
  const c = (window as unknown as { claude?: ClaudeRuntime }).claude;
  return c && typeof c.use === "function" ? c : null;
}

export async function getSample(): Promise<SampleFn | null> {
  const rt = runtime();
  if (!rt) return null;
  try {
    return ((await rt.use("sample")) as SampleFn | null) ?? null;
  } catch {
    return null;
  }
}

/** ¿Puede esta vista enviar imágenes a Claude? (depende de la app o navegador donde se abre la página) */
export async function sampleSupportsImages(sample: SampleFn): Promise<boolean> {
  try {
    return Boolean((await sample.limits()).images);
  } catch {
    return false;
  }
}

async function getDownloads(): Promise<Downloads | null> {
  const rt = runtime();
  if (!rt) return null;
  try {
    return ((await rt.use("downloads")) as Downloads | null) ?? null;
  } catch {
    return null;
  }
}

/** ¿Puede esta vista guardar ficheros? (siempre en local; en el visor, si concede `downloads`) */
export async function canSaveFiles(): Promise<boolean> {
  if (!runtime()) return true;
  return (await getDownloads()) !== null;
}

/** Guarda un fichero: descarga normal en local, o diálogo de guardado en el visor. Devuelve false si se cancela. */
export async function saveFile(blob: Blob, filename: string): Promise<boolean> {
  const downloads = await getDownloads();
  if (!downloads) {
    downloadBlob(blob, filename);
    return true;
  }
  try {
    await downloads.save({ filename, data: blob });
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "declined") return false;
    throw new Error(code === "rate_limited" ? "Ya hay una descarga pendiente de confirmar." : "Esta vista no permite descargar ficheros.");
  }
}

// ── Asistente a través de `sample` ──────────────────────────────────────────

const MAX_WEB_FILE_CHARS = 180_000;

function base64ToBlob(data: string, type: string): Blob {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** Elige `max` elementos repartidos de forma uniforme (p. ej. fotogramas de un vídeo). */
function spread<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  return Array.from({ length: max }, (_, i) => items[Math.round((i * (items.length - 1)) / Math.max(1, max - 1))]);
}

export interface WebChatRequest {
  history: ChatTurn[];
  prompt: string;
  files: FileMap;
  activeFile?: string;
  attachments?: ChatAttachment[];
  mode?: "edit" | "generate-from-reference";
}

const ERROR_COPY: Record<string, string> = {
  cancelled: "Generación detenida por el usuario.",
  not_granted: "No se dio permiso para usar Claude en esta página. Recárgala y acepta el permiso para usar la IA.",
  sampling_disabled: "La IA no está disponible para tu cuenta u organización.",
  rate_limited: "Has alcanzado el límite de uso por ahora. Espera un poco y vuelve a intentarlo.",
  session_expired: "Tu sesión de claude.ai ha caducado. Vuelve a iniciar sesión.",
  image_rejected: "La imagen no se pudo usar. Prueba con otra captura (PNG o JPG).",
  images_unavailable: "Esta vista no puede enviar imágenes a la IA.",
  refused: "La IA no ha podido procesar esta petición. Prueba con otra imagen o reformúlala.",
  empty_completion: "La IA no devolvió nada. Prueba a pedirlo de otra forma.",
  prompt_too_large: "El proyecto es demasiado grande para la versión web. Usa la app en tu ordenador.",
};

/** Envía la petición del asistente a Claude mediante `sample` y devuelve el texto completo. */
export async function sampleChat(
  sample: SampleFn,
  req: WebChatRequest,
  onText: (text: string) => void,
  signal: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  const limits = await sample.limits().catch(() => null);
  const imageAtts = (req.attachments ?? []).filter((a): a is Extract<ChatAttachment, { type: "image" }> => a.type === "image");
  const pdfs = (req.attachments ?? []).filter((a) => a.type === "pdf");
  const texts = (req.attachments ?? []).filter((a): a is Extract<ChatAttachment, { type: "text" }> => a.type === "text");

  if (pdfs.length && !imageAtts.length && !texts.length) {
    throw new Error("La versión web no puede leer PDF. Haz una captura de la página del PDF y súbela como imagen.");
  }
  if (imageAtts.length && !limits?.images) throw new Error(ERROR_COPY.images_unavailable);
  const chosen = spread(imageAtts, limits?.images?.maxCount ?? 0);

  const instructions = [SYSTEM_PROMPT, req.mode === "generate-from-reference" ? REFERENCE_PROMPT : ""].filter(Boolean).join("\n\n");
  const turns: SampleTurn[] = [{ role: "user", content: `Instrucciones que debes seguir siempre:\n\n${instructions}` }];
  for (const t of req.history.slice(-8)) {
    const content = t.role === "assistant" ? summarizeFileBlocks(t.content) : t.content;
    if (content.trim()) turns.push({ role: t.role, content });
  }
  let filesContext: string;
  try {
    filesContext = buildFilesContext(req.files, req.activeFile, MAX_WEB_FILE_CHARS);
  } catch {
    throw new Error(ERROR_COPY.prompt_too_large);
  }
  const parts = [
    chosen.length
      ? `Imágenes adjuntas, en este orden: ${chosen.map((a, i) => `${i + 1}) ${a.label ?? "referencia"}`).join("; ")}.`
      : "",
    pdfs.length ? "(Se omitieron los PDF: la versión web no puede leerlos.)" : "",
    ...texts.map((t) => `${t.label ? `Adjunto "${t.label}":\n` : ""}${t.text}`),
    filesContext,
    `Petición del usuario:\n${req.prompt}`,
  ].filter(Boolean);
  turns.push({ role: "user", content: parts.join("\n\n") });

  try {
    return await sample(turns, {
      signal,
      cache: false,
      modelTier: req.mode === "generate-from-reference" ? "complex" : "default",
      images: chosen.map((a) => base64ToBlob(a.data, a.mediaType)),
      onText: ({ text }) => onText(text),
    });
  } catch (err) {
    const e = err as SampleError;
    const wrapped = new Error(ERROR_COPY[e.code] ?? "La IA no respondió. Inténtalo de nuevo en un momento.") as Error & { partial?: string };
    if (e.code === "cancelled") wrapped.name = "AbortError";
    wrapped.partial = e.text;
    throw wrapped;
  }
}
