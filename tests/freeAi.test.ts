import { afterEach, describe, expect, it, vi } from "vitest";
import { streamGemini, streamOpenRouter } from "../src/lib/freeAi";
import { detectProvider } from "../src/db/db";
import type { ChatStreamEvent } from "../shared/types";

afterEach(() => vi.unstubAllGlobals());

const sse = (objs: unknown[]) =>
  new Response(objs.map((o) => `data: ${typeof o === "string" ? o : JSON.stringify(o)}\r\n\r\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const req = { apiKey: "k", history: [], prompt: "Hola", files: { "index.html": "<h1>x</h1>" }, attachments: [{ type: "image" as const, mediaType: "image/png" as const, data: "AAAA", label: "captura" }] };

describe("IA gratuita", () => {
  it("reconoce el servicio por la clave", () => {
    expect(detectProvider("AIzaSyA1234567890abcdefghijklmnopqrstuv")).toBe("gemini");
    expect(detectProvider("AQ.Ab8RN6Kx1234567890abcdefghijklmnop")).toBe("gemini");
    expect(detectProvider("AQ")).toBeNull();
    expect(detectProvider("sk-or-v1-abc")).toBe("openrouter");
    expect(detectProvider("sk-ant-api03-x")).toBe("anthropic");
    expect(detectProvider("hola")).toBeNull();
  });

  it("Gemini: si un modelo agotó su cupo usa el siguiente y envía la imagen", async () => {
    const seen: string[] = [];
    let body: { contents: Array<{ parts: Array<Record<string, unknown>> }>; systemInstruction: unknown } | null = null;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const model = url.match(/models\/([^:]+):/)![1];
      seen.push(model);
      if (seen.length === 1) return new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }), { status: 429 });
      body = JSON.parse(String(init.body));
      return sse([{ candidates: [{ content: { parts: [{ text: "Hecho. " }, { text: "pensando", thought: true }] } }] }, { candidates: [{ content: { parts: [{ text: '<file path="index.html">ok</file>' }] }, finishReason: "STOP" }] }]);
    });
    const events: ChatStreamEvent[] = [];
    await streamGemini(req, (e) => events.push(e), new AbortController().signal);
    const text = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
    expect(text).toBe('Hecho. <file path="index.html">ok</file>');
    expect(seen.length).toBe(2);
    expect(JSON.stringify(body!.contents.at(-1)!.parts)).toContain('"inlineData"');
    expect(body!.systemInstruction).toBeTruthy();
    expect(events.at(-1)?.type).toBe("done");
  });

  it("Gemini: clave no válida da un mensaje claro", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }), { status: 400 }));
    await expect(streamGemini(req, () => {}, new AbortController().signal)).rejects.toThrow(/clave de Google no es válida/);
  });

  it("OpenRouter: usa un modelo gratuito con visión", async () => {
    let chosen = "";
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models"))
        return new Response(
          JSON.stringify({
            data: [
              { id: "vendor/texto:free", context_length: 100000, architecture: { input_modalities: ["text"] } },
              { id: "google/gemma-vision:free", context_length: 128000, architecture: { input_modalities: ["text", "image"] } },
              { id: "caro/modelo", context_length: 200000, architecture: { input_modalities: ["text", "image"] } },
            ],
          }),
        );
      chosen = JSON.parse(String(init!.body)).model;
      return sse([{ choices: [{ delta: { content: "ok" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }, "[DONE]"]);
    });
    const events: ChatStreamEvent[] = [];
    await streamOpenRouter(req, (e) => events.push(e), new AbortController().signal);
    expect(chosen).toBe("google/gemma-vision:free");
    expect(events.some((e) => e.type === "text" && e.text === "ok")).toBe(true);
  });
});
