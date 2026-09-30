/**
 * IA gratuita desde el navegador:
 * - Google Gemini (plan gratuito de Google AI Studio: clave gratis, sin tarjeta).
 * - OpenRouter (modelos «:free»: clave gratis, sin tarjeta).
 * Mismo protocolo de ficheros (<file path="…">) e instrucciones que con Claude,
 * así que clonar, comparar y aplicar cambios funciona igual.
 */
import type {
  ChatAttachment,
  ChatRequest,
  ChatStreamEvent,
} from "../../shared/types";
import { summarizeFileBlocks } from "../../shared/fileBlocks";
import {
  REFERENCE_PROMPT,
  SYSTEM_PROMPT,
  buildFilesContext,
} from "../../shared/prompts";

const MAX_FILE_CHARS = 400_000;

/** Del mejor al más ligero: si uno no existe o agotó su cupo diario, se prueba el siguiente */
export const GEMINI_MODELS = [
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
];

type Emit = (e: ChatStreamEvent) => void;

/** Modelo → hora hasta la que no se vuelve a probar (agotó su cupo gratuito) */
const exhaustedUntil = new Map<string, number>();

class ProviderError extends Error {
  constructor(
    message: string,
    /** Probar con otro modelo puede funcionar (no existe, sin cupo, saturado) */
    readonly tryNext: boolean,
    readonly status = 0,
  ) {
    super(message);
  }
}

function systemText(req: ChatRequest): string {
  return req.mode === "generate-from-reference"
    ? `${SYSTEM_PROMPT}\n\n${REFERENCE_PROMPT}`
    : SYSTEM_PROMPT;
}

/** Texto de la última petición: adjuntos de texto, ficheros actuales y lo que pide el usuario */
function requestText(req: ChatRequest): { before: string[]; after: string[] } {
  const before: string[] = [];
  for (const a of req.attachments ?? [])
    if (a.type === "text")
      before.push(`${a.label ? `Adjunto "${a.label}":\n` : ""}${a.text}`);
  const after = [
    buildFilesContext(req.files, req.activeFile, MAX_FILE_CHARS),
    `Petición del usuario:\n${req.prompt}`,
  ];
  return { before, after };
}

function history(req: ChatRequest) {
  const out: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const t of req.history ?? []) {
    if (!t.content?.trim()) continue;
    if (!out.length && t.role !== "user") continue;
    out.push({
      role: t.role,
      text: t.role === "assistant" ? summarizeFileBlocks(t.content) : t.content,
    });
  }
  return out;
}

/** Lee un flujo SSE y llama a `onData` con cada bloque `data:` */
async function readSse(
  res: Response,
  onData: (data: string) => void,
  signal: AbortSignal,
) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    if (signal.aborted) {
      await reader.cancel().catch(() => {});
      break;
    }
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, "");
      const data = chunk
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) onData(data);
    }
  }
  const rest = buffer.trim();
  if (rest.startsWith("data:")) onData(rest.slice(5).trimStart());
}

/** Si falla cuando ya se había escrito parte de la respuesta, no se reintenta con otro modelo (se duplicaría el texto) */
async function midStream(emitted: () => number, run: () => Promise<void>) {
  try {
    await run();
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    if (emitted() > 0)
      throw new ProviderError(
        `La respuesta se cortó: ${(err as Error).message}`,
        false,
      );
    throw err;
  }
}

/** Cupo gratuito agotado: la app puede saltar a otro servicio automáticamente. */
function quotaError(message: string): Error {
  const e = new Error(message);
  e.name = "QuotaError";
  return e;
}

function aborted(): Error {
  const err = new Error("Generación detenida por el usuario.");
  err.name = "AbortError";
  return err;
}

// ── Google Gemini ──────────────────────────────────────────────────────────

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

function geminiParts(atts: ChatAttachment[] | undefined): GeminiPart[] {
  const parts: GeminiPart[] = [];
  for (const a of atts ?? []) {
    if (a.type === "image") {
      if (a.label) parts.push({ text: `Referencia: ${a.label}` });
      parts.push({ inlineData: { mimeType: a.mediaType, data: a.data } });
    } else if (a.type === "pdf") {
      if (a.label) parts.push({ text: `Documento: ${a.label}` });
      parts.push({ inlineData: { mimeType: "application/pdf", data: a.data } });
    }
  }
  return parts;
}

async function geminiError(res: Response): Promise<ProviderError> {
  let message = "";
  let reason = "";
  try {
    const j = (await res.json()) as {
      error?: {
        message?: string;
        status?: string;
        details?: Array<{ reason?: string }>;
      };
    };
    message = j.error?.message ?? "";
    reason =
      j.error?.details?.find((d) => d.reason)?.reason ?? j.error?.status ?? "";
  } catch {
    /* sin cuerpo JSON */
  }
  if (
    res.status === 400 &&
    /API_KEY_INVALID|API key not valid/i.test(reason + message)
  )
    return new ProviderError(
      "La clave de Google no es válida. Cópiala de nuevo desde aistudio.google.com.",
      false,
      400,
    );
  if (res.status === 403)
    return new ProviderError(
      "La clave de Google no tiene permiso para usar Gemini. Crea una nueva en aistudio.google.com.",
      false,
      403,
    );
  if (
    res.status === 404 ||
    (res.status === 400 &&
      /not found|not supported|is not available/i.test(message))
  )
    return new ProviderError(
      `Modelo no disponible: ${message}`,
      true,
      res.status,
    );
  if (res.status === 429)
    return new ProviderError("límite gratuito alcanzado", true, 429);
  if (res.status >= 500)
    return new ProviderError(
      "Google está saturado en este momento",
      true,
      res.status,
    );
  return new ProviderError(
    `Error de Google (${res.status}): ${message || res.statusText}`,
    false,
    res.status,
  );
}

async function geminiOnce(
  model: string,
  req: ChatRequest,
  emit: Emit,
  signal: AbortSignal,
  withUrlTool: boolean,
) {
  const contents: Array<{ role: "user" | "model"; parts: GeminiPart[] }> =
    history(req).map((t) => ({
      role: t.role === "assistant" ? "model" : "user",
      parts: [{ text: t.text }],
    }));
  const { before, after } = requestText(req);
  contents.push({
    role: "user",
    parts: [
      ...before.map((text) => ({ text })),
      ...geminiParts(req.attachments),
      ...after.map((text) => ({ text })),
    ],
  });

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": req.apiKey!,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemText(req) }] },
        contents,
        generationConfig: { maxOutputTokens: 65536, temperature: 0.3 },
        // Con enlace: Gemini puede leer la web él mismo (herramienta gratuita «url_context»)
        ...(withUrlTool ? { tools: [{ url_context: {} }] } : {}),
      }),
      signal,
    },
  );
  if (!res.ok) throw await geminiError(res);

  let emitted = 0;
  let finish: string | null = null;
  let usage: { input: number; output: number } | undefined;
  await midStream(
    () => emitted,
    () =>
      readSse(
        res,
        (data) => {
          let j: {
            candidates?: Array<{
              content?: { parts?: Array<{ text?: string; thought?: boolean }> };
              finishReason?: string;
            }>;
            usageMetadata?: {
              promptTokenCount?: number;
              candidatesTokenCount?: number;
            };
            error?: { message?: string };
          };
          try {
            j = JSON.parse(data);
          } catch {
            return;
          }
          if (j.error)
            throw new ProviderError(
              `Error de Google: ${j.error.message ?? "desconocido"}`,
              false,
            );
          const c = j.candidates?.[0];
          for (const p of c?.content?.parts ?? []) {
            if (p.thought || !p.text) continue;
            emitted += p.text.length;
            emit({ type: "text", text: p.text });
          }
          if (c?.finishReason) finish = c.finishReason;
          if (j.usageMetadata)
            usage = {
              input: j.usageMetadata.promptTokenCount ?? 0,
              output: j.usageMetadata.candidatesTokenCount ?? 0,
            };
        },
        signal,
      ),
  );
  if (signal.aborted) throw aborted();
  if (
    !emitted &&
    (finish === "SAFETY" ||
      finish === "PROHIBITED_CONTENT" ||
      finish === "RECITATION")
  )
    throw new ProviderError(
      "Google ha bloqueado esta respuesta. Prueba con otra captura o reformula la petición.",
      false,
    );
  if (!emitted)
    throw new ProviderError("Gemini no devolvió ninguna respuesta", true);
  emit({
    type: "done",
    stopReason: finish === "MAX_TOKENS" ? "max_tokens" : "end_turn",
    usage,
    model: `Google ${model} (gratis)`,
  });
}

export async function streamGemini(
  req: ChatRequest,
  emit: Emit,
  signal: AbortSignal,
): Promise<void> {
  if (!req.apiKey)
    throw new Error("Falta la clave gratuita de Google. Añádela en Ajustes.");
  let lastLimit = false;
  let last: unknown;
  // Si todos los modelos agotaron su cupo hace poco, no se reintentan: se avisa ya para saltar a otra IA
  const rested = GEMINI_MODELS.filter((m) => (exhaustedUntil.get(m) ?? 0) < Date.now());
  if (!rested.length)
    throw quotaError(
      "El cupo gratuito de Google está agotado por ahora (se renueva solo). Añade una clave gratuita de OpenRouter en Ajustes y la app se turnará sola.",
    );
  for (const model of rested) {
    let withUrlTool = !!req.webFetch;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        emit({
          type: "status",
          message: `Generando con Google ${model} (gratis)…`,
        });
        await geminiOnce(model, req, emit, signal, withUrlTool);
        return;
      } catch (err) {
        if (signal.aborted || (err as Error).name === "AbortError")
          throw aborted();
        last = err;
        const e = err as ProviderError;
        // Sin herramienta de lectura de webs en este modelo: se reintenta sin ella
        if (withUrlTool && e.status === 400) {
          withUrlTool = false;
          continue;
        }
        if (e.status >= 500 && attempt < 1) {
          await new Promise((r) => setTimeout(r, 2500));
          continue;
        }
        if (e.status === 429) {
          lastLimit = true;
          exhaustedUntil.set(model, Date.now() + 10 * 60_000);
        }
        break;
      }
    }
    const e = last as ProviderError;
    if (!(e instanceof ProviderError) || !e.tryNext) break;
  }
  if (lastLimit)
    throw quotaError(
      "Has usado el cupo gratuito de Google por ahora (se renueva solo: espera un minuto o, si es el límite diario, hasta mañana). También puedes añadir una clave gratuita de OpenRouter en Ajustes y la app se turnará sola.",
    );
  throw last instanceof Error
    ? last
    : new Error("No se pudo usar la IA de Google.");
}

// ── OpenRouter (modelos gratuitos) ─────────────────────────────────────────

interface OrModel {
  id: string;
  context_length?: number;
  architecture?: { input_modalities?: string[] };
  pricing?: { prompt?: string; completion?: string };
}

let orModelsCache: OrModel[] | null = null;

/** Modelos gratuitos de OpenRouter que aceptan imágenes (la lista cambia con el tiempo, así que se consulta). */
async function freeOpenRouterModels(needsImages: boolean): Promise<string[]> {
  const preferred = [
    "google/gemma",
    "qwen/qwen",
    "meta-llama/llama-4",
    "mistralai/",
    "nvidia/",
  ];
  try {
    if (!orModelsCache) {
      const res = await fetch("https://openrouter.ai/api/v1/models", {
        credentials: "omit",
      });
      orModelsCache = ((await res.json()) as { data?: OrModel[] }).data ?? [];
    }
    const free = orModelsCache.filter(
      (m) =>
        m.id.endsWith(":free") &&
        (!needsImages || m.architecture?.input_modalities?.includes("image")) &&
        (m.context_length ?? 0) >= 32_000,
    );
    const rank = (id: string) => {
      const i = preferred.findIndex((p) => id.startsWith(p));
      return i === -1 ? preferred.length : i;
    };
    free.sort(
      (a, b) =>
        rank(a.id) - rank(b.id) ||
        (b.context_length ?? 0) - (a.context_length ?? 0),
    );
    const ids = free.map((m) => m.id).slice(0, 4);
    if (ids.length) return [...ids, "openrouter/free"];
  } catch {
    /* sin lista: se usa el enrutador de modelos gratuitos */
  }
  return ["openrouter/free"];
}

type OrContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    >;

async function openRouterOnce(
  model: string,
  req: ChatRequest,
  emit: Emit,
  signal: AbortSignal,
) {
  const messages: Array<{ role: string; content: OrContent }> = [
    { role: "system", content: systemText(req) },
  ];
  for (const t of history(req))
    messages.push({ role: t.role, content: t.text });
  const { before, after } = requestText(req);
  const parts: Exclude<OrContent, string> = before.map((text) => ({
    type: "text" as const,
    text,
  }));
  for (const a of req.attachments ?? []) {
    if (a.type !== "image") continue;
    if (a.label) parts.push({ type: "text", text: `Referencia: ${a.label}` });
    parts.push({
      type: "image_url",
      image_url: { url: `data:${a.mediaType};base64,${a.data}` },
    });
  }
  for (const text of after) parts.push({ type: "text", text });
  messages.push({ role: "user", content: parts });

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${req.apiKey}`,
      "X-Title": "DevStudio Pro",
    },
    body: JSON.stringify({ model, messages, stream: true, temperature: 0.3 }),
    signal,
  });
  if (!res.ok) {
    let message = "";
    try {
      message =
        ((await res.json()) as { error?: { message?: string } }).error
          ?.message ?? "";
    } catch {
      /* sin cuerpo */
    }
    if (res.status === 401)
      throw new ProviderError(
        "La clave de OpenRouter no es válida. Cópiala de nuevo desde openrouter.ai/keys.",
        false,
        401,
      );
    if (res.status === 402)
      throw new ProviderError(
        "Ese modelo de OpenRouter no es gratuito.",
        true,
        402,
      );
    throw new ProviderError(
      `OpenRouter (${res.status}): ${message || res.statusText}`,
      res.status === 404 || res.status === 429 || res.status >= 500,
      res.status,
    );
  }
  let emitted = 0;
  let finish: string | null = null;
  let usage: { input: number; output: number } | undefined;
  await midStream(
    () => emitted,
    () =>
      readSse(
        res,
        (data) => {
          if (data === "[DONE]") return;
          let j: {
            choices?: Array<{
              delta?: { content?: string };
              finish_reason?: string | null;
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
            error?: { message?: string; code?: number };
          };
          try {
            j = JSON.parse(data);
          } catch {
            return;
          }
          if (j.error)
            throw new ProviderError(
              `OpenRouter: ${j.error.message ?? "error"}`,
              !emitted,
              j.error.code ?? 0,
            );
          const ch = j.choices?.[0];
          if (ch?.delta?.content) {
            emitted += ch.delta.content.length;
            emit({ type: "text", text: ch.delta.content });
          }
          if (ch?.finish_reason) finish = ch.finish_reason;
          if (j.usage)
            usage = {
              input: j.usage.prompt_tokens ?? 0,
              output: j.usage.completion_tokens ?? 0,
            };
        },
        signal,
      ),
  );
  if (signal.aborted) throw aborted();
  if (!emitted)
    throw new ProviderError("El modelo gratuito no devolvió respuesta", true);
  emit({
    type: "done",
    stopReason: finish === "length" ? "max_tokens" : "end_turn",
    usage,
    model: `${model} (gratis)`,
  });
}

export async function streamOpenRouter(
  req: ChatRequest,
  emit: Emit,
  signal: AbortSignal,
): Promise<void> {
  if (!req.apiKey)
    throw new Error(
      "Falta la clave gratuita de OpenRouter. Añádela en Ajustes.",
    );
  const needsImages = (req.attachments ?? []).some((a) => a.type === "image");
  let last: unknown;
  for (const model of await freeOpenRouterModels(needsImages)) {
    try {
      emit({ type: "status", message: `Generando con ${model} (gratis)…` });
      await openRouterOnce(model, req, emit, signal);
      return;
    } catch (err) {
      if (signal.aborted || (err as Error).name === "AbortError")
        throw aborted();
      last = err;
      if (!(err instanceof ProviderError) || !err.tryNext) break;
    }
  }
  const e = last as ProviderError;
  if (e?.status === 429)
    throw quotaError(
      "Has usado el cupo gratuito de OpenRouter por hoy (50 peticiones al día). Vuelve mañana o usa la clave gratuita de Google.",
    );
  throw last instanceof Error
    ? last
    : new Error("No se pudo usar la IA de OpenRouter.");
}
