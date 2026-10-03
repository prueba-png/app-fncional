import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import { runClaudeChat } from "../shared/claudeChat";

// Simula la API de Anthropic: la primera respuesta falla con «Overloaded» (como ocurrió en una prueba real)
let calls = 0;
let failWith: "overloaded" | "none" = "overloaded";
let base = "";
const sse = (res: http.ServerResponse, ev: { type: string } & Record<string, unknown>) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
const server = http.createServer(async (req, res) => {
  for await (const _chunk of req);
  calls++;
  res.writeHead(200, { "content-type": "text/event-stream" });
  sse(res, { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
  if (failWith === "overloaded" && calls === 1) {
    sse(res, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
    return res.end();
  }
  sse(res, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  sse(res, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Listo" } });
  sse(res, { type: "content_block_stop", index: 0 });
  sse(res, { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
  sse(res, { type: "message_stop" });
  res.end();
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("runClaudeChat", () => {
  it("reintenta automáticamente si la IA está saturada antes de escribir", async () => {
    calls = 0;
    failWith = "overloaded";
    const events: string[] = [];
    await runClaudeChat(
      new Anthropic({ apiKey: "x", baseURL: base, maxRetries: 0 }),
      { history: [], prompt: "hola", files: { "index.html": "<p>x</p>" } },
      (e) => events.push(e.type === "text" ? `text:${e.text}` : e.type),
    );
    expect(calls).toBe(2);
    expect(events).toContain("text:Listo");
    expect(events).toContain("done");
    expect(events).not.toContain("error");
  }, 20_000);
});
