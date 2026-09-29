import { Router, type Request, type Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import type { ChatRequest, ChatStreamEvent } from "../../shared/types";
import { summarizeFileBlocks } from "../../shared/fileBlocks";
import { REFERENCE_PROMPT, SYSTEM_PROMPT, buildFilesContext } from "../lib/prompts";

export const DEFAULT_MODEL = "claude-opus-5-5";
/** Modelos que admiten el parámetro `fallbacks: "default"` (reintento automático ante un rechazo). */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
const MAX_FILE_CHARS = 400_000;

export const llmRouter = Router();

function sse(res: Response, event: ChatStreamEvent) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function buildMessages(body: ChatRequest): Anthropic.Beta.BetaMessageParam[] {
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const turn of body.history ?? []) {
    if (!turn.content?.trim()) continue;
    if (!messages.length && turn.role !== "user") continue; // el primer mensaje debe ser del usuario
    messages.push({ role: turn.role, content: turn.role === "assistant" ? summarizeFileBlocks(turn.content) : turn.content });
  }

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const att of body.attachments ?? []) {
    if (att.type === "image") {
      if (att.label) content.push({ type: "text", text: `Referencia: ${att.label}` });
      content.push({ type: "image", source: { type: "base64", media_type: att.mediaType, data: att.data } });
    } else if (att.type === "pdf") {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: att.data }, title: att.label });
    } else if (att.type === "text") {
      content.push({ type: "text", text: `${att.label ? `Adjunto "${att.label}":\n` : ""}${att.text}` });
    }
  }
  content.push({ type: "text", text: buildFilesContext(body.files, body.activeFile, MAX_FILE_CHARS) });
  content.push({ type: "text", text: `Petición del usuario:\n${body.prompt}` });
  messages.push({ role: "user", content });
  return messages;
}

llmRouter.post("/chat", async (req: Request, res: Response) => {
  const body = req.body as ChatRequest;
  const apiKey = body.apiKey?.trim() || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(400).json({ error: "Configura tu clave de API de Anthropic en Ajustes o en la variable ANTHROPIC_API_KEY." });
    return;
  }
  if (!body.prompt?.trim()) {
    res.status(400).json({ error: "La petición está vacía." });
    return;
  }

  let messages: Anthropic.Beta.BetaMessageParam[];
  try {
    messages = buildMessages(body);
  } catch (err) {
    res.status(413).json({ error: (err as Error).message });
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const model = body.model?.trim() || DEFAULT_MODEL;
  const client = new Anthropic({ apiKey });
  const useFallbacks = FALLBACK_MODELS.has(model);
  const supportsAdaptive = !model.startsWith("claude-haiku");
  const system = body.mode === "generate-from-reference" ? `${SYSTEM_PROMPT}\n\n${REFERENCE_PROMPT}` : SYSTEM_PROMPT;

  const stream = client.beta.messages.stream({
    model,
    max_tokens: 64000,
    system,
    // Haiku 4.5 no admite pensamiento adaptativo ni `effort`
    ...(supportsAdaptive ? { thinking: { type: "adaptive" as const }, output_config: { effort: body.effort ?? "high" } } : {}),
    messages,
    ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
  });

  let closed = false;
  res.on("close", () => {
    closed = true;
    stream.abort();
  });

  sse(res, { type: "status", message: `Generando con ${model}…` });
  try {
    for await (const event of stream) {
      if (closed) break;
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        sse(res, { type: "text", text: event.delta.text });
      } else if (event.type === "content_block_start" && event.content_block.type === "fallback") {
        sse(res, { type: "status", message: `Respuesta continuada por ${event.content_block.to.model}` });
      }
    }
    if (closed) return;
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      sse(res, { type: "error", message: "El modelo ha declinado esta petición. Reformúlala e inténtalo de nuevo." });
    }
    sse(res, {
      type: "done",
      stopReason: final.stop_reason,
      model: final.model,
      usage: { input: final.usage.input_tokens, output: final.usage.output_tokens },
    });
  } catch (err) {
    if (closed) return;
    let message = (err as Error).message;
    if (err instanceof Anthropic.AuthenticationError) message = "Clave de API no válida.";
    else if (err instanceof Anthropic.RateLimitError) message = "Límite de peticiones alcanzado; espera unos segundos.";
    else if (err instanceof Anthropic.BadRequestError) message = `Petición rechazada por la API: ${err.message}`;
    else if (err instanceof Anthropic.APIError) message = `Error de la API (${err.status ?? "?"}): ${err.message}`;
    sse(res, { type: "error", message });
  } finally {
    if (!closed) res.end();
  }
});
