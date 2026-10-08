import { afterEach, describe, expect, it, vi } from "vitest";
import { connectTimeout, streamGemini, streamOpenRouter, transcribeAudio } from "../src/lib/freeAi";
import { detectProvider } from "../src/db/db";
import type { ChatStreamEvent } from "../shared/types";

afterEach(() => vi.unstubAllGlobals());

const sse = (objs: unknown[]) =>
  new Response(objs.map((o) => `data: ${typeof o === "string" ? o : JSON.stringify(o)}\r\n\r\n`).join(""), { headers: { "content-type": "text/event-stream" } });
// Cada test usa una clave distinta para no compartir la caché de modelos descubiertos
const makeReq = (apiKey: string) => ({ apiKey, history: [], prompt: "Hola", files: { "index.html": "<h1>x</h1>" }, attachments: [{ type: "image" as const, mediaType: "image/png" as const, data: "AAAA", label: "captura" }] });
const isDiscovery = (url: string) => /\/models\?/.test(url);
const modelList = (...ids: string[]) => new Response(JSON.stringify({ models: ids.map((id) => ({ name: `models/${id}`, supportedGenerationMethods: ["generateContent"] })) }));

describe("IA gratuita", () => {
  it("reconoce el servicio por la clave", () => {
    expect(detectProvider("AIzaSyA1234567890abcdefghijklmnopqrstuv")).toBe("gemini");
    expect(detectProvider("AQ.Ab8RN6Kx1234567890abcdefghijklmnop")).toBe("gemini");
    expect(detectProvider("AQ")).toBeNull();
    expect(detectProvider("sk-or-v1-abc")).toBe("openrouter");
    expect(detectProvider("sk-ant-api03-x")).toBe("anthropic");
    expect(detectProvider("hola")).toBeNull();
  });

  it("Gemini: descubre modelos, si uno agota su cupo usa el siguiente y envía la imagen", async () => {
    const seen: string[] = [];
    let body: { contents: Array<{ parts: Array<Record<string, unknown>> }>; systemInstruction: unknown } | null = null;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (isDiscovery(url)) return modelList("gemini-3-flash-a", "gemini-3-flash-b");
      const model = url.match(/models\/([^:]+):/)![1];
      seen.push(model);
      if (seen.length === 1) return new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }), { status: 429 });
      body = JSON.parse(String(init.body));
      return sse([{ candidates: [{ content: { parts: [{ text: "Hecho. " }, { text: "pensando", thought: true }] } }] }, { candidates: [{ content: { parts: [{ text: '<file path="index.html">ok</file>' }] }, finishReason: "STOP" }] }]);
    });
    const events: ChatStreamEvent[] = [];
    await streamGemini(makeReq("k-descubre"), (e) => events.push(e), new AbortController().signal);
    const text = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
    expect(text).toBe('Hecho. <file path="index.html">ok</file>');
    expect(seen.length).toBe(2);
    expect(JSON.stringify(body!.contents.at(-1)!.parts)).toContain('"inlineData"');
    expect(body!.systemInstruction).toBeTruthy();
    expect(events.at(-1)?.type).toBe("done");
  });

  it("Gemini: un modelo retirado («no longer available») hace que pruebe el siguiente", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      if (isDiscovery(url)) return modelList("gemini-3-flash-viejo", "gemini-2-flash-nuevo");
      const model = url.match(/models\/([^:]+):/)![1];
      seen.push(model);
      if (model === "gemini-3-flash-viejo")
        return new Response(JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT", message: "This model models/gemini-3-flash-viejo is no longer available to new users. Please update your code." } }), { status: 400 });
      return sse([{ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }]);
    });
    const events: ChatStreamEvent[] = [];
    await streamGemini(makeReq("k-retirado"), (e) => events.push(e), new AbortController().signal);
    expect(seen).toEqual(["gemini-3-flash-viejo", "gemini-2-flash-nuevo"]);
    expect(events.some((e) => e.type === "text" && e.text === "ok")).toBe(true);
  });

  it("Gemini: si no se puede consultar el catálogo, usa la lista de reserva", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      if (isDiscovery(url)) return new Response("no", { status: 500 });
      seen.push(url.match(/models\/([^:]+):/)![1]);
      return sse([{ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }]);
    });
    await streamGemini(makeReq("k-reserva"), () => {}, new AbortController().signal);
    expect(seen[0]).toBe("gemini-flash-latest"); // alias que no caduca
  });

  it("Gemini: clave no válida da un mensaje claro", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (isDiscovery(url)) return modelList("gemini-flash-clave");
      return new Response(JSON.stringify({ error: { message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }), { status: 400 });
    });
    await expect(streamGemini(makeReq("k-mala"), () => {}, new AbortController().signal)).rejects.toThrow(/clave de Google no es válida/);
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
    await streamOpenRouter(makeReq("k-or"), (e) => events.push(e), new AbortController().signal);
    expect(chosen).toBe("google/gemma-vision:free");
    expect(events.some((e) => e.type === "text" && e.text === "ok")).toBe(true);
  });

  it("OpenRouter: un 400 «Provider returned error» (modelo saturado) prueba otro modelo en vez de rendirse", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "a/modelo-saturado:free", context_length: 100000 }, { id: "b/modelo-bueno:free", context_length: 100000 }] }));
      const model = JSON.parse(String(init!.body)).model;
      seen.push(model);
      if (seen.length === 1) return new Response(JSON.stringify({ error: { message: "Provider returned error" } }), { status: 400 });
      return sse([{ choices: [{ delta: { content: "ok" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }, "[DONE]"]);
    });
    const events: ChatStreamEvent[] = [];
    await streamOpenRouter(makeReq("k-or-400"), (e) => events.push(e), new AbortController().signal);
    expect(seen.length).toBe(2); // probó un segundo modelo en vez de rendirse en el primero
    expect(events.some((e) => e.type === "text" && e.text === "ok")).toBe(true);
  });

  it("OpenRouter: si TODOS los modelos devuelven «ResourceExhausted» (saturados), se puede saltar a otra IA (como el cupo agotado)", async () => {
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "c/modelo-1:free", context_length: 100000 }] }));
      return sse([{ error: { message: "Upstream error from Nvidia: ResourceExhausted: Worker local total request limit reached (16/16)", code: 400 } }]);
    });
    await expect(streamOpenRouter(makeReq("k-or-exhausted"), () => {}, new AbortController().signal)).rejects.toMatchObject({
      name: "QuotaError",
      message: expect.stringContaining("saturados"),
    });
  });
});

describe("cupo agotado", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("Gemini lanza QuotaError cuando todos los modelos dan 429", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (isDiscovery(url)) return modelList("gemini-flash-x1", "gemini-flash-x2");
      return new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }), { status: 429 });
    });
    await expect(streamGemini(makeReq("k-agotado"), () => {}, new AbortController().signal)).rejects.toMatchObject({ name: "QuotaError" });
  });

  it("distingue el límite por minuto (mensaje de esperar un minuto) del límite diario real (quotaId con PerDay)", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (isDiscovery(url)) return modelList("gemini-flash-minuto");
      return new Response(
        JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [{ violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }] }, { retryDelay: "38s" }] } }),
        { status: 429 },
      );
    });
    await expect(streamGemini(makeReq("k-minuto"), () => {}, new AbortController().signal)).rejects.toMatchObject({ name: "QuotaError", message: expect.stringContaining("por minuto") });
  });

  it("avisa del límite diario real (no «espera un minuto») cuando el quotaId dice PerDay", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (isDiscovery(url)) return modelList("gemini-flash-dia");
      return new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } }), { status: 429 });
    });
    await expect(streamGemini(makeReq("k-dia"), () => {}, new AbortController().signal)).rejects.toMatchObject({ name: "QuotaError", message: expect.stringContaining("DIARIO") });
  });

  it("si el límite «por minuto» se repite tras esperar lo indicado, avisa de que probablemente es el cupo diario", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", async (url: string) => {
        if (isDiscovery(url)) return modelList("gemini-flash-repetido");
        return new Response(
          JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [{ violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }] }, { retryDelay: "30s" }] } }),
          { status: 429 },
        );
      });
      const key = "k-repetido";
      await expect(streamGemini(makeReq(key), () => {}, new AbortController().signal)).rejects.toMatchObject({ message: expect.stringContaining("por minuto") });
      // El usuario espera bastante más de lo que Google pidió (30 s) antes de reintentar
      await vi.advanceTimersByTimeAsync(45_000);
      await expect(streamGemini(makeReq(key), () => {}, new AbortController().signal)).rejects.toMatchObject({ name: "QuotaError", message: expect.stringContaining("no siempre es exacto") });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("varias claves de Google a la vez (cada una con su propio cupo diario)", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("si la primera clave agota su cupo, se prueba automáticamente la siguiente sin que el usuario haga nada", async () => {
    const seenKeys: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (isDiscovery(url)) return modelList("gemini-flash-multi");
      const key = (init?.headers as Record<string, string> | undefined)?.["x-goog-api-key"] ?? new URL(url).searchParams.get("key") ?? "";
      seenKeys.push(key);
      if (key === "k-multi-1") return new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } }), { status: 429 });
      return sse([{ candidates: [{ content: { parts: [{ text: "ok con la segunda clave" }] }, finishReason: "STOP" }] }]);
    });
    const events: ChatStreamEvent[] = [];
    await streamGemini(makeReq("k-multi-1,k-multi-2"), (e) => events.push(e), new AbortController().signal);
    const text = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
    expect(text).toBe("ok con la segunda clave");
    expect(seenKeys).toEqual(["k-multi-1", "k-multi-2"]);
  });

  it("si TODAS las claves agotan su cupo diario, el aviso lo deja claro (no sugiere añadir una clave que ya tiene)", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (isDiscovery(url)) return modelList("gemini-flash-multi-agotado");
      return new Response(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } }), { status: 429 });
    });
    await expect(streamGemini(makeReq("k-multi-a,k-multi-b"), () => {}, new AbortController().signal)).rejects.toMatchObject({
      name: "QuotaError",
      message: expect.stringContaining("todas las claves"),
    });
  });
});

describe("connectTimeout (límite de tiempo SOLO para conectar, no para toda la respuesta)", () => {
  it("si se llama a clear() (el fetch ya respondió), no aborta aunque pase de sobra el tiempo del límite", async () => {
    const { signal, clear } = connectTimeout(new AbortController().signal, 20);
    clear();
    await new Promise((r) => setTimeout(r, 60));
    expect(signal.aborted).toBe(false);
  });

  it("si NO se llama a clear() (no hay ni respuesta), aborta pasado el tiempo del límite", async () => {
    const { signal } = connectTimeout(new AbortController().signal, 20);
    await new Promise((r) => setTimeout(r, 60));
    expect(signal.aborted).toBe(true);
  });

  it("si el usuario cancela (su señal), aborta también aunque ya se hubiera llamado a clear()", async () => {
    const user = new AbortController();
    const { signal, clear } = connectTimeout(user.signal, 20);
    clear();
    user.abort();
    expect(signal.aborted).toBe(true);
  });
});

describe("fallos de red (Load failed)", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("Gemini reintenta el mismo modelo si la red falla y luego funciona", async () => {
    let n = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (isDiscovery(url)) return modelList("gemini-flash-red");
      n++;
      if (n === 1) throw new TypeError("Load failed"); // primer intento: red caída
      return sse([{ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }]);
    });
    const events: ChatStreamEvent[] = [];
    await streamGemini(makeReq("k-red"), (e) => events.push(e), new AbortController().signal);
    expect(n).toBe(2);
    expect(events.some((e) => e.type === "text" && e.text === "ok")).toBe(true);
  });

  it("Gemini da un mensaje claro (no «Load failed») si la red falla siempre", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (isDiscovery(url)) return modelList("gemini-flash-red2");
      throw new TypeError("Load failed");
    });
    await expect(streamGemini(makeReq("k-red2"), () => {}, new AbortController().signal)).rejects.toThrow(/conexión|Vuelve a intentarlo/i);
  });

  it("Gemini se rinde tras 2 intentos (no 3) para no tardar minutos con una conexión caída, y marca el error como de red", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (isDiscovery(url)) return modelList("gemini-flash-red3");
      attempts++;
      throw new TypeError("Failed to fetch");
    });
    await expect(streamGemini(makeReq("k-red3"), () => {}, new AbortController().signal)).rejects.toMatchObject({ name: "NetworkError" });
    expect(attempts).toBe(2);
  });

  it("no corta una respuesta sana solo por tardar más de 20 s en completarse (antes eso bastaba para que saltara 'se perdió la conexión')", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", async (url: string) => {
        if (isDiscovery(url)) return modelList("gemini-flash-lento");
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "parte1 " }] } }] })}\r\n\r\n`));
            // Deliberadamente más de los 20 s del límite para "conectar": si ese límite siguiera vivo
            // durante toda la respuesta (el fallo original), esto la cortaría a mitad.
            setTimeout(() => {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "parte2" }] }, finishReason: "STOP" }] })}\r\n\r\n`));
              controller.close();
            }, 22_000);
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      });
      const events: ChatStreamEvent[] = [];
      const done = streamGemini(makeReq("k-lento"), (e) => events.push(e), new AbortController().signal);
      await vi.advanceTimersByTimeAsync(22_000);
      await done;
      const text = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
      expect(text).toBe("parte1 parte2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Gemini activa la búsqueda en internet cuando se pide (google_search) además de leer una URL si toca", async () => {
    let sawTools: unknown;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (isDiscovery(url)) return modelList("gemini-flash-search");
      sawTools = JSON.parse(String(init!.body)).tools;
      return sse([{ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }]);
    });
    await streamGemini({ ...makeReq("k-search"), webSearch: true }, () => {}, new AbortController().signal);
    expect(sawTools).toEqual([{ google_search: {} }]);
  });

  it("un «AbortError» de nuestro propio límite de tiempo al conectar (no el botón Detener) se reintenta, no se confunde con una cancelación", async () => {
    // Simula lo que produce un fetch() cuyo AbortSignal.timeout interno salta: un AbortError, aunque
    // la señal del usuario (la que pasa el botón «Detener») sigue intacta.
    let n = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (isDiscovery(url)) return modelList("gemini-flash-timeout");
      n++;
      if (n === 1) {
        const e = new Error("This operation was aborted");
        e.name = "AbortError";
        throw e;
      }
      return sse([{ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] }]);
    });
    const userSignal = new AbortController().signal; // el usuario nunca pulsa «Detener»
    const events: ChatStreamEvent[] = [];
    await streamGemini(makeReq("k-timeout"), (e) => events.push(e), userSignal);
    expect(n).toBe(2); // se reintentó en vez de rendirse como «cancelado»
    expect(events.some((e) => e.type === "text" && e.text === "ok")).toBe(true);
    expect(events.every((e) => e.type !== "error")).toBe(true);
  });

  it("si el usuario SÍ pulsa «Detener» (su señal se marca), el error es una cancelación real", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", async (url: string) => {
      if (isDiscovery(url)) return modelList("gemini-flash-real-stop");
      controller.abort(); // el «Detener» se pulsa mientras la petición está en marcha
      const e = new Error("This operation was aborted");
      e.name = "AbortError";
      throw e;
    });
    await expect(streamGemini(makeReq("k-real-stop"), () => {}, controller.signal)).rejects.toMatchObject({ name: "AbortError", message: "Generación detenida por el usuario." });
  });
});

describe("transcribeAudio (dictado por voz en Safari, sin SpeechRecognition)", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("transcribe el audio grabado", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      expect(url).toContain(":generateContent");
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Cambia el color del botón a verde" }] } }] }));
    });
    const text = await transcribeAudio("AIzaSyA1234567890abcdefghijklmnopqrstuv", "AAAA", "audio/webm");
    expect(text).toBe("Cambia el color del botón a verde");
  });

  it("da un mensaje claro si la clave no es válida", async () => {
    vi.stubGlobal("fetch", async () => new Response("API key not valid", { status: 400 }));
    await expect(transcribeAudio("clave-mala", "AAAA", "audio/webm")).rejects.toThrow(/clave de Google no es válida/);
  });
});

describe("límite de tamaño del proyecto (por proveedor, según su contexto real)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("Gemini acepta un proyecto grande y real que antes fallaba con el límite plano de 400.000 caracteres", async () => {
    // Un index.html + styles.css grandes (como un sitio real con mucho CSS), bastante por encima de 400.000
    // caracteres en total, pero muy por debajo de lo que admite el contexto de Gemini.
    const bigCss = "body{color:#111}\n".repeat(30_000); // ~480.000 caracteres
    vi.stubGlobal("fetch", async (url: string) => {
      if (isDiscovery(url)) return modelList("gemini-flash-grande");
      return sse([{ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }]);
    });
    const req = { ...makeReq("k-grande-gemini"), files: { "index.html": "<h1>x</h1>", "styles.css": bigCss } };
    const events: ChatStreamEvent[] = [];
    await streamGemini(req, (e) => events.push(e), new AbortController().signal);
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("OpenRouter sigue avisando con un mensaje claro si el proyecto no cabe en su límite (más bajo, por sus modelos gratuitos)", async () => {
    const bigCss = "body{color:#111}\n".repeat(30_000); // ~480.000 caracteres: cabe en Gemini, no en OpenRouter
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ data: [{ id: "modelo-gratis:free", context_length: 32_000 }] })));
    const req = { ...makeReq("sk-or-v1-grande"), files: { "index.html": "<h1>x</h1>", "styles.css": bigCss } };
    await expect(streamOpenRouter(req, () => {}, new AbortController().signal)).rejects.toThrow(/supera.*caracteres/i);
  });
});

describe("aviso honesto de si hay o no herramienta de navegación web (para que no se invente usarla)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("OpenRouter: avisa de que NO tiene ninguna herramienta de navegación si no se pidió webFetch", async () => {
    let systemMsg = "";
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "a/modelo:free", context_length: 100000 }] }));
      const body = JSON.parse(String(init!.body));
      systemMsg = body.messages.find((m: { role: string }) => m.role === "system")?.content ?? "";
      return sse([{ choices: [{ delta: { content: "ok" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }, "[DONE]"]);
    });
    await streamOpenRouter(makeReq("k-or-sin-tool"), () => {}, new AbortController().signal);
    expect(systemMsg).toMatch(/NINGUNA/);
    expect(systemMsg).toMatch(/no simule haber usado una herramienta|simule haber usado una herramienta/i);
  });

  it("OpenRouter: con webFetch pedido, usa de verdad una herramienta fetch_url (descarga la página real, no se la inventa)", async () => {
    const pageHtml = "<!doctype html><html><head><title>Sitio real</title></head><body><h1>Contenido real del sitio</h1></body></html>";
    let finalSystemMsg = "";
    let toolRounds = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "a/modelo-con-tools:free", context_length: 100000 }] }));
      // La propia herramienta descarga la página por el mismo servicio de reenvío que "Clonar una web"
      if (url.includes("allorigins.win") || url.includes("codetabs.com")) {
        return new Response(pageHtml, { headers: { "content-type": "text/html" } });
      }
      const body = JSON.parse(String(init!.body));
      if (body.stream === false) {
        toolRounds++;
        if (toolRounds === 1) {
          // Primera vuelta: el modelo pide la herramienta
          return new Response(
            JSON.stringify({
              choices: [{ message: { role: "assistant", tool_calls: [{ id: "call_1", function: { name: "fetch_url", arguments: JSON.stringify({ url: "https://sitio-real.test/" }) } }] }, finish_reason: "tool_calls" }],
            }),
          );
        }
        // Segunda vuelta: ya tiene el HTML real (se lo pasamos como mensaje "tool") y da la respuesta final
        const toolMsg = body.messages.find((m: { role: string }) => m.role === "tool");
        finalSystemMsg = body.messages.find((m: { role: string }) => m.role === "system")?.content ?? "";
        expect(toolMsg?.content).toContain("Contenido real del sitio");
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "<file path=\"index.html\">\n<h1>Contenido real del sitio</h1>\n</file>" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 10 },
          }),
        );
      }
      throw new Error("no debería llegar a una llamada en streaming: la herramienta ya resolvió la respuesta final");
    });
    const events: ChatStreamEvent[] = [];
    await streamOpenRouter({ ...makeReq("k-or-tool"), webFetch: true }, (e) => events.push(e), new AbortController().signal);
    expect(toolRounds).toBe(2);
    expect(finalSystemMsg).toMatch(/SÍ tienes conectada/);
    expect(events.some((e) => e.type === "text" && e.text.includes("Contenido real del sitio"))).toBe(true);
  });

  it("Gemini: cuando SÍ tiene url_context conectado, lo dice explícitamente (no en condicional)", async () => {
    let systemMsg = "";
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (isDiscovery(url)) return modelList("gemini-flash-tool");
      const body = JSON.parse(String(init!.body));
      systemMsg = body.systemInstruction.parts[0].text;
      return sse([{ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }]);
    });
    await streamGemini({ ...makeReq("k-gemini-tool"), webFetch: true }, () => {}, new AbortController().signal);
    expect(systemMsg).toMatch(/SÍ tienes conectada/);
  });
});
