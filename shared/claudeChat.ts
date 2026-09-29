/**
 * Llamada al asistente con el SDK oficial de Anthropic, compartida por el
 * servidor local (que la reenvía por SSE) y el navegador (versión publicada,
 * con la clave del propio usuario).
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ChatRequest, ChatStreamEvent } from "./types";
import { summarizeFileBlocks } from "./fileBlocks";
import { REFERENCE_PROMPT, SYSTEM_PROMPT, buildFilesContext } from "./prompts";

export const DEFAULT_MODEL = "claude-opus-5-5";
/** Modelos que admiten el parámetro `fallbacks: "default"` (reintento automático ante un rechazo). */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
const MAX_FILE_CHARS = 400_000;

export function buildMessages(body: ChatRequest): Anthropic.Beta.BetaMessageParam[] {
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

/** Mensaje comprensible para un error de la API. */
export function describeApiError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "Clave de API no válida.";
  if (err instanceof Anthropic.PermissionDeniedError) return "Tu clave no tiene permiso para usar este modelo.";
  if (err instanceof Anthropic.RateLimitError) return "Límite de peticiones alcanzado; espera unos segundos.";
  if (err instanceof Anthropic.BadRequestError) {
    if (/credit balance/i.test(err.message)) return "Tu cuenta de Anthropic no tiene saldo. Añade crédito en console.anthropic.com (Billing).";
    return `Petición rechazada por la API: ${err.message}`;
  }
  if (err instanceof Anthropic.APIConnectionError) return "No se pudo conectar con la IA. Revisa tu conexión a internet.";
  if (err instanceof Anthropic.APIError) return `Error de la API (${err.status ?? "?"}): ${err.message}`;
  return (err as Error).message;
}

/**
 * Ejecuta una petición del asistente en streaming y emite eventos de texto,
 * estado, error y fin. Lanza solo si la petición no se puede construir.
 */
export async function runClaudeChat(
  client: Anthropic,
  body: ChatRequest,
  emit: (e: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const messages = buildMessages(body);
  const model = body.model?.trim() || DEFAULT_MODEL;
  const useFallbacks = FALLBACK_MODELS.has(model);
  const supportsAdaptive = !model.startsWith("claude-haiku");
  const system = body.mode === "generate-from-reference" ? `${SYSTEM_PROMPT}\n\n${REFERENCE_PROMPT}` : SYSTEM_PROMPT;
  const tools: Anthropic.Beta.BetaToolUnion[] | undefined = body.webFetch
    ? [{ type: "web_fetch_20260209", name: "web_fetch", max_uses: 4, max_content_tokens: 100_000 }]
    : undefined;

  let current: ReturnType<typeof client.beta.messages.stream> | null = null;
  const onAbort = () => current?.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  emit({ type: "status", message: `Generando con ${model}…` });
  try {
    let conversation = messages;
    let final: Anthropic.Beta.BetaMessage | null = null;
    // Las herramientas de servidor (web_fetch) pueden pausar el turno: se reenvía lo recibido para que continúe
    for (let round = 0; round < 4; round++) {
      const stream = client.beta.messages.stream({
        model,
        max_tokens: 64000,
        system,
        // Haiku 4.5 no admite pensamiento adaptativo ni `effort`
        ...(supportsAdaptive ? { thinking: { type: "adaptive" as const }, output_config: { effort: body.effort ?? "high" } } : {}),
        messages: conversation,
        ...(tools ? { tools } : {}),
        ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      });
      current = stream;
      for await (const event of stream) {
        if (signal?.aborted) return;
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          emit({ type: "text", text: event.delta.text });
        } else if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block.type === "fallback") emit({ type: "status", message: `Respuesta continuada por ${block.to.model}` });
          else if (block.type === "server_tool_use" && block.name === "web_fetch") emit({ type: "status", message: "Visitando la web…" });
          else if (block.type === "web_fetch_tool_result" && (block.content as { type?: string }).type === "web_fetch_tool_result_error") {
            emit({ type: "status", message: `No se pudo leer la web (${(block.content as { error_code?: string }).error_code ?? "error"})` });
          }
        }
      }
      final = await stream.finalMessage();
      if (final.stop_reason !== "pause_turn") break;
      conversation = [...conversation, { role: "assistant", content: final.content }];
    }
    if (!final) return;
    if (final.stop_reason === "refusal") {
      emit({ type: "error", message: "El modelo ha declinado esta petición. Reformúlala e inténtalo de nuevo." });
    }
    emit({
      type: "done",
      stopReason: final.stop_reason,
      model: final.model,
      usage: { input: final.usage.input_tokens, output: final.usage.output_tokens },
    });
  } catch (err) {
    if (signal?.aborted) return;
    emit({ type: "error", message: describeApiError(err) });
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
