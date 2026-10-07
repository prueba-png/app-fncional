/**
 * Llamada al asistente con el SDK oficial de Anthropic, compartida por el
 * servidor local (que la reenvía por SSE) y el navegador (versión publicada,
 * con la clave del propio usuario).
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ChatRequest, ChatStreamEvent } from "./types";
import { summarizeFileBlocks } from "./fileBlocks";
import { IMPROVE_CHANGE_PROMPT, IMPROVE_PROMPT, REFERENCE_PROMPT, SYSTEM_PROMPT, buildFilesContext, FILE_CHAR_BUDGET_ANTHROPIC as MAX_FILE_CHARS } from "./prompts";

export const DEFAULT_MODEL = "claude-opus-5-5";
/** Modelos que admiten el parámetro `fallbacks: "default"` (reintento automático ante un rechazo). */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

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
/** La IA está saturada o tuvo un fallo momentáneo (vale la pena reintentar). */
export function isTransientError(err: unknown): boolean {
  if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) return true;
  if (err instanceof Anthropic.APIError && (err.status === 529 || err.status === 503)) return true;
  return /overloaded_error|Overloaded|api_error/i.test((err as Error)?.message ?? "");
}

export function describeApiError(err: unknown): string {
  if (/overloaded_error|Overloaded/i.test((err as Error)?.message ?? "") || (err instanceof Anthropic.APIError && err.status === 529))
    return "La IA de Anthropic está saturada en este momento. Espera unos segundos y pulsa «Reintentar».";
  if (err instanceof Anthropic.AuthenticationError) return "Clave de API no válida.";
  if (err instanceof Anthropic.PermissionDeniedError) return "Tu clave no tiene permiso para usar este modelo.";
  if (err instanceof Anthropic.RateLimitError) return "Límite de peticiones alcanzado; espera unos segundos.";
  if (err instanceof Anthropic.BadRequestError) {
    if (/credit balance/i.test(err.message)) return "Tu cuenta de Anthropic no tiene saldo. Añade crédito en console.anthropic.com (Billing).";
    return `Petición rechazada por la API: ${err.message}`;
  }
  if (err instanceof Anthropic.APIConnectionError) return "No se pudo conectar con la IA. Revisa tu conexión a internet.";
  if (err instanceof Anthropic.InternalServerError || (err instanceof Anthropic.APIError && /api_error/i.test(err.message)))
    return "La IA tuvo un fallo momentáneo. Pulsa «Reintentar» en unos segundos.";
  if (err instanceof Anthropic.APIError) return `Error de la IA (${err.status ?? "?"}): ${err.message.slice(0, 200)}`;
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
  const tools: Anthropic.Beta.BetaToolUnion[] | undefined = body.webFetch
    ? [{ type: "web_fetch_20260209", name: "web_fetch", max_uses: 4, max_content_tokens: 100_000 }]
    : undefined;
  // El SYSTEM_PROMPT describe la herramienta de navegación en condicional ("si la tienes"): un modelo no
  // siempre sabe con fiabilidad si está conectada de verdad, y puede acabar "simulando" su uso con una
  // etiqueta de texto en vez de decir honestamente que no la tiene. Se deja explícito en cada petición.
  const toolNote = tools
    ? "\n\nHerramientas de navegación web en esta conversación: SÍ tienes conectada la de visitar una URL real (web_fetch). No hace falta que lo anuncies con una etiqueta de texto: simplemente úsala."
    : "\n\nHerramientas de navegación web en esta conversación: NINGUNA. No tienes forma de visitar ninguna URL ni de buscar en internet ahora mismo. Si la petición depende de eso, dilo claramente en tu explicación en vez de inventar el contenido o de escribir texto que simule haber usado una herramienta (como una etiqueta <web_fetch> u otra parecida): eso no ejecuta nada de verdad y confundiría al usuario.";
  const system =
    (body.mode === "improve-prompt"
      ? IMPROVE_PROMPT
      : body.mode === "improve-change"
        ? IMPROVE_CHANGE_PROMPT
        : body.mode === "generate-from-reference"
          ? `${SYSTEM_PROMPT}\n\n${REFERENCE_PROMPT}`
          : SYSTEM_PROMPT) + toolNote;

  let current: ReturnType<typeof client.beta.messages.stream> | null = null;
  const onAbort = () => current?.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  emit({ type: "status", message: `Generando con ${model}…` });
  try {
    let conversation = messages;
    let final: Anthropic.Beta.BetaMessage | null = null;
    // Las herramientas de servidor (web_fetch) pueden pausar el turno: se reenvía lo recibido para que continúe
    for (let round = 0, retries = 0; round < 4; round++) {
      let emittedText = false;
      const stream = client.beta.messages.stream({
        model,
        max_tokens: 64000,
        system,
        // Haiku 4.5 no admite pensamiento adaptativo ni `effort`
        ...(supportsAdaptive ? { thinking: { type: "adaptive" as const }, output_config: { effort: body.effort ?? "medium" } } : {}),
        messages: conversation,
        ...(tools ? { tools } : {}),
        ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      });
      current = stream;
      try {
        for await (const event of stream) {
          if (signal?.aborted) return;
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            emittedText = true;
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
      } catch (err) {
        // IA saturada antes de escribir nada: se reintenta automáticamente (hasta 3 veces, con espera creciente)
        if (!signal?.aborted && !emittedText && retries < 3 && isTransientError(err)) {
          retries++;
          emit({ type: "status", message: `La IA está saturada; reintentando (${retries}/3)…` });
          await new Promise((r) => setTimeout(r, 3000 * retries));
          if (signal?.aborted) return;
          round--;
          continue;
        }
        throw err;
      }
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
