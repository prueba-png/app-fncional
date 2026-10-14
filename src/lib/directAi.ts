/**
 * Versión publicada (Netlify): el navegador habla directamente con la API de
 * Anthropic usando la clave que el usuario guarda en este navegador. Así la
 * generación no depende de los límites de tiempo de las funciones del servidor.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ChatRequest, ChatStreamEvent } from "../../shared/types";
import { runClaudeChat } from "../../shared/claudeChat";

export async function streamDirect(req: ChatRequest, onEvent: (e: ChatStreamEvent) => void, signal: AbortSignal): Promise<void> {
  if (!req.apiKey) throw new Error("Falta la clave de la IA. Añádela en Ajustes.");
  const client = new Anthropic({ apiKey: req.apiKey, dangerouslyAllowBrowser: true });
  await runClaudeChat(client, req, onEvent, signal);
  if (signal.aborted) {
    const err = new Error("Generación detenida por el usuario.");
    err.name = "AbortError";
    throw err;
  }
}
