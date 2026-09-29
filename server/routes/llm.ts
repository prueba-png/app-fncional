import { Router, type Request, type Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import type { ChatRequest, ChatStreamEvent } from "../../shared/types";
import { buildMessages, runClaudeChat } from "../../shared/claudeChat";

export { DEFAULT_MODEL } from "../../shared/claudeChat";

export const llmRouter = Router();

function sse(res: Response, event: ChatStreamEvent) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
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
  try {
    buildMessages(body); // valida el tamaño antes de abrir el flujo
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

  const controller = new AbortController();
  res.on("close", () => controller.abort());
  try {
    await runClaudeChat(new Anthropic({ apiKey }), body, (e) => !controller.signal.aborted && sse(res, e), controller.signal);
  } finally {
    if (!controller.signal.aborted) res.end();
  }
});
