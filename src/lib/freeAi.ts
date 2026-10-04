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
import { sanitizeKey } from "./util";
import {
  IMPROVE_PROMPT,
  REFERENCE_PROMPT,
  SYSTEM_PROMPT,
  buildFilesContext,
} from "../../shared/prompts";

// El límite debe ir según el contexto real del modelo, no un número fijo para cualquiera: Gemini (flash)
// admite ~1M tokens, los modelos de pago de Claude suelen rondar 200k; los gratuitos de OpenRouter
// elegidos aquí garantizan un mínimo de 32k tokens (ver discoverOpenRouterModels), bastante menos. Antes
// un único límite de 400.000 caracteres (~100k tokens) hacía fallar sin necesidad clones grandes y reales
// en Gemini (sitios como un concesionario de coches o un banco, con mucho CSS/HTML), y a la vez podía ser
// demasiado para el modelo gratuito de OpenRouter más pequeño que se llegara a elegir.
const MAX_FILE_CHARS_GEMINI = 1_500_000;
const MAX_FILE_CHARS_OPENROUTER = 110_000;
/** Tiempo máximo para conectar antes de dar la conexión por caída (una conexión colgada no debe tardar minutos en fallar) */
const CONNECT_TIMEOUT_MS = 20_000;

/** Combina la señal de cancelación del usuario con un límite de tiempo para conectar. */
function withConnectTimeout(signal: AbortSignal, ms = CONNECT_TIMEOUT_MS): AbortSignal {
  return AbortSignal.any ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : signal;
}

/**
 * Lista de reserva por si no se puede consultar el catálogo. Los alias «-latest» apuntan siempre
 * al modelo actual, así que no hay que actualizarlos cuando Google saca versiones nuevas.
 */
export const GEMINI_MODELS = [
  "gemini-flash-latest",
  "gemini-flash-lite-latest",
  "gemini-3-flash-preview",
];

/** Modelos descubiertos por clave (se consulta una vez por sesión). */
const geminiModelCache = new Map<string, string[]>();

/** Puntúa un modelo flash para elegir el más nuevo y capaz primero. */
function scoreGeminiModel(id: string): number {
  const ver = parseFloat(id.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] ?? "0");
  const latest = /-latest$/.test(id) ? 1 : 0; // los alias «latest» no caducan
  const full = /lite/i.test(id) ? 0 : 1; // «flash» algo mejor que «flash-lite»
  const stable = /preview|exp|thinking/i.test(id) ? 0 : 1;
  return ver * 100 + latest * 20 + full * 5 + stable;
}

/**
 * Pregunta a Google qué modelos puede usar esta clave y elige los «flash» (los del plan gratuito),
 * del más nuevo al más ligero. Así la app usa siempre los últimos modelos sin tener que actualizarse.
 */
async function discoverGeminiModels(apiKey: string): Promise<string[]> {
  const cached = geminiModelCache.get(apiKey);
  if (cached) return cached;
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
    const ids = (data.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m) => (m.name ?? "").replace(/^models\//, ""))
      .filter((id) => /flash/i.test(id) && !/(embedding|aqa|imagen|image-generation|-tts|-vision|learnlm|gemma)/i.test(id));
    // Prioriza modelos «flash» normales; añade también algún «pro» como último recurso si no hubiera flash
    const flash = ids.sort((a, b) => scoreGeminiModel(b) - scoreGeminiModel(a));
    const list = flash.length ? [...new Set(flash)] : GEMINI_MODELS;
    geminiModelCache.set(apiKey, list);
    return list;
  } catch {
    return GEMINI_MODELS;
  }
}

type Emit = (e: ChatStreamEvent) => void;

/** Modelo → hora hasta la que no se vuelve a probar (agotó su cupo gratuito) */
const exhaustedUntil = new Map<string, number>();

/**
 * Clave → veces seguidas que ha dado 429 "por minuto" tras esperar el tiempo indicado. Si Google sigue
 * devolviendo el mismo error después de haber esperado de sobra, el límite real no es "por minuto" (el
 * aviso de Google no siempre distingue bien los dos casos): es más probable que sea el cupo diario.
 */
const consecutivePerMinuteHits = new Map<string, number>();

/** Cuántos segundos se esperan datos antes de dar la conexión por colgada y reintentar */
const STALL_MS = 25_000;

/**
 * Fallo de red (conexión caída, sin cobertura, envío cortado): en el móvil aparece como
 * «Load failed» o «Failed to fetch». Se puede reintentar.
 */
function isNetworkError(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  const m = `${e?.name ?? ""} ${e?.message ?? ""}`.toLowerCase();
  if (e?.name === "TypeError" || e?.name === "TimeoutError") return true;
  // Un «AbortError» que llega aquí (el aviso de cancelación real del usuario ya se descartó antes de
  // llamar a esta función) solo puede venir de nuestro propio límite de tiempo al conectar: es de red.
  if (e?.name === "AbortError") return true;
  return /load failed|failed to fetch|networkerror|network error|network request failed|the network connection was lost|conexión|timeout|timed out|err_|fetch failed|connection|stream (?:se )?cort|se cortó/i.test(m);
}

/**
 * OpenRouter envía estos avisos (código 400, o incluso con 200 pero dentro del propio stream) cuando el
 * modelo gratuito elegido está saturado en ese momento (demasiados usuarios, su backend sin hueco, etc.):
 * no es un fallo de la petición en sí, así que merece la pena probar otro modelo o proveedor.
 */
function isUpstreamCongestion(message: string): boolean {
  return /provider returned error|upstream error|resourceexhausted|resource_exhausted|rate.?limit|overloaded|no instances available|no endpoints found|worker local total request limit|capacity/i.test(message);
}

/** Cupo gratuito agotado O proveedor saturado en este momento: en ambos casos conviene saltar a otra IA. */
function providerBusyError(message: string): Error {
  const e = new Error(message);
  e.name = "QuotaError";
  return e;
}

/** Mensaje claro en español para el usuario a partir de un error cualquiera. */
function friendlyMessage(err: unknown): string {
  if (isNetworkError(err))
    return "Se perdió la conexión al hablar con la IA (habitual con datos móviles). Vuelve a intentarlo; si falla mucho, usa wifi o prueba de nuevo en un momento.";
  const m = (err as Error)?.message;
  return m && m.length < 300 ? m : "No se pudo completar la petición. Inténtalo de nuevo.";
}

class ProviderError extends Error {
  constructor(
    message: string,
    /** Probar con otro modelo puede funcionar (no existe, sin cupo, saturado) */
    readonly tryNext: boolean,
    readonly status = 0,
    /** Solo en 429: si Google dijo cuánto esperar y si el límite es diario (no por minuto) */
    readonly quota?: { retryMs?: number; daily: boolean },
  ) {
    super(message);
  }
}

/**
 * El SYSTEM_PROMPT dice "si tienes herramienta de navegar la web en esta conversación, visítala", pero
 * un modelo no siempre sabe fiablemente si la tiene de verdad conectada (sobre todo los gratuitos de
 * OpenRouter, que aquí nunca la tienen): en vez de adivinar, a veces "simulan" la herramienta escribiendo
 * una etiqueta de texto con pinta de llamada (p. ej. "<web_fetch>https://...</web_fetch>") como si la
 * hubiera usado, cuando no ha pasado nada real. Esta línea deja la disponibilidad real explícita cada
 * vez, para que nunca tenga que adivinarlo ni fingir que la usó.
 */
function toolAvailabilityNote(hasFetchTool: boolean, hasSearchTool: boolean): string {
  if (!hasFetchTool && !hasSearchTool)
    return "\n\nHerramientas de navegación web en esta conversación: NINGUNA. No tienes forma de visitar ninguna URL ni de buscar en internet ahora mismo. Si la petición depende de eso, dilo claramente en tu explicación en vez de inventar el contenido o de escribir texto que simule haber usado una herramienta (como una etiqueta <web_fetch> u otra parecida): eso no ejecuta nada de verdad y confundiría al usuario.";
  const parts: string[] = [];
  if (hasFetchTool) parts.push("puedes visitar una URL real con tu herramienta de navegación (úsala si la petición menciona una)");
  if (hasSearchTool) parts.push("puedes buscar en internet con tu herramienta de búsqueda");
  return `\n\nHerramientas de navegación web en esta conversación: SÍ tienes conectada(s) ${parts.join(" y ")}. No hace falta que lo anuncies con una etiqueta de texto: simplemente úsala.`;
}

function systemText(req: ChatRequest, hasFetchTool: boolean, hasSearchTool: boolean): string {
  if (req.mode === "improve-prompt") return IMPROVE_PROMPT;
  const base = req.mode === "generate-from-reference" ? `${SYSTEM_PROMPT}\n\n${REFERENCE_PROMPT}` : SYSTEM_PROMPT;
  return base + toolAvailabilityNote(hasFetchTool, hasSearchTool);
}

/** Texto de la última petición: adjuntos de texto, ficheros actuales y lo que pide el usuario */
function requestText(req: ChatRequest, maxChars: number): { before: string[]; after: string[] } {
  const before: string[] = [];
  for (const a of req.attachments ?? [])
    if (a.type === "text")
      before.push(`${a.label ? `Adjunto "${a.label}":\n` : ""}${a.text}`);
  const after = [
    buildFilesContext(req.files, req.activeFile, maxChars),
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
  stallMs = STALL_MS,
) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    if (signal.aborted) {
      await reader.cancel().catch(() => {});
      break;
    }
    // Vigilante de conexión colgada: si no llegan datos en stallMs, se corta y se reintenta. Con la
    // herramienta de leer la web activada, el modelo puede tardar bastante en devolver el primer byte
    // (está visitando la página en su servidor, sin emitir nada mientras tanto): no es la conexión del
    // usuario la que falla, así que ese caso necesita un margen mayor que el normal.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stall = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("La conexión se cortó (sin respuesta).")), stallMs);
    });
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await Promise.race([reader.read(), stall]);
    } catch (err) {
      await reader.cancel().catch(() => {});
      throw err;
    } finally {
      clearTimeout(timer);
    }
    const { done, value } = result;
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
async function midStream(signal: AbortSignal, emitted: () => number, run: () => Promise<void>) {
  try {
    await run();
  } catch (err) {
    // Solo es «el usuario canceló» si su propia señal está marcada; un AbortError con la señal del
    // usuario intacta viene de nuestro límite de tiempo al conectar (fallo de red), no de pulsar «Detener»
    if (signal.aborted) throw err;
    if (emitted() > 0)
      throw new ProviderError(
        isNetworkError(err) ? "La respuesta se cortó a mitad (se perdió la conexión). Vuelve a pulsar para continuar." : `La respuesta se cortó: ${(err as Error).message}`,
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

/** Fallo de red que agotó todos sus reintentos: la app puede saltar a otro servicio automáticamente. */
function networkFailedError(message: string): Error {
  const e = new Error(message);
  e.name = "NetworkError";
  return e;
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
  let quota: { retryMs?: number; daily: boolean } | undefined;
  try {
    const j = (await res.json()) as {
      error?: {
        message?: string;
        status?: string;
        details?: Array<{
          reason?: string;
          violations?: Array<{ quotaId?: string }>;
          retryDelay?: string;
        }>;
      };
    };
    message = j.error?.message ?? "";
    reason =
      j.error?.details?.find((d) => d.reason)?.reason ?? j.error?.status ?? "";
    if (res.status === 429) {
      // Google indica en los detalles si el límite agotado es "por día" (PerDay) o "por minuto" (PerMinute),
      // y a veces cuánto esperar exactamente (RetryInfo.retryDelay, p. ej. "38s"). Con eso se puede avisar
      // con precisión en vez de decir siempre "espera hasta mañana" cuando solo hay que esperar un minuto.
      const quotaId = j.error?.details?.flatMap((d) => d.violations ?? []).find((v) => v.quotaId)?.quotaId ?? "";
      const retrySecs = j.error?.details?.find((d) => d.retryDelay)?.retryDelay;
      quota = {
        daily: /perday/i.test(quotaId),
        retryMs: retrySecs ? parseFloat(retrySecs) * 1000 : undefined,
      };
    }
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
    ((res.status === 400 || res.status === 403) &&
      /not found|not supported|no longer available|not available|unavailable|deprecat|update your code|no longer supported/i.test(message))
  )
    return new ProviderError(
      `Modelo no disponible: ${message}`,
      true,
      res.status,
    );
  if (res.status === 429)
    return new ProviderError("límite gratuito alcanzado", true, 429, quota);
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
  const { before, after } = requestText(req, MAX_FILE_CHARS_GEMINI);
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
        systemInstruction: { parts: [{ text: systemText(req, withUrlTool, !!req.webSearch) }] },
        contents,
        generationConfig: { maxOutputTokens: 65536, temperature: 0.3 },
        // Con enlace: Gemini puede leer la web él mismo (herramienta gratuita «url_context»)
        // Con búsqueda: Gemini puede consultar Google para datos reales antes de responder («google_search»)
        ...(withUrlTool || req.webSearch
          ? { tools: [...(withUrlTool ? [{ url_context: {} }] : []), ...(req.webSearch ? [{ google_search: {} }] : [])] }
          : {}),
      }),
      signal: withConnectTimeout(signal),
    },
  );
  if (!res.ok) throw await geminiError(res);

  let emitted = 0;
  let finish: string | null = null;
  let usage: { input: number; output: number } | undefined;
  await midStream(
    signal,
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
        withUrlTool || req.webSearch ? 60_000 : STALL_MS,
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

/**
 * Convierte un audio grabado en el navegador a texto con Gemini. Se usa como alternativa al dictado
 * nativo del navegador (`SpeechRecognition`), que Safari (iPhone/iPad) no trae incorporado: ahí se
 * graba el audio con MediaRecorder y se transcribe aquí en vez de usar el reconocimiento de voz del propio navegador.
 */
export async function transcribeAudio(
  apiKey: string,
  base64: string,
  mimeType: string,
  signal?: AbortSignal,
): Promise<string> {
  const key = sanitizeKey(apiKey);
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType, data: base64 } },
              { text: "Transcribe literalmente lo que se dice en este audio, en español. Responde solo con el texto transcrito, sin comentarios ni comillas. Si no hay ninguna voz, responde con una cadena vacía." },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: 2048, temperature: 0 },
      }),
      signal,
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 400 && /API key not valid/i.test(body)) throw new Error("La clave de Google no es válida.");
    if (res.status === 429) throw new Error("Se ha superado el límite gratuito de Google por ahora.");
    throw new Error(`Google respondió con un error (${res.status}).`);
  }
  const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  return text.trim();
}

export async function streamGemini(
  req: ChatRequest,
  emit: Emit,
  signal: AbortSignal,
): Promise<void> {
  if (!req.apiKey)
    throw new Error("Falta la clave gratuita de Google. Añádela en Ajustes.");
  // Por si la clave se guardó antes de limpiar caracteres invisibles del copia-pega, se limpia también aquí
  req.apiKey = sanitizeKey(req.apiKey);
  let lastLimit = false;
  let lastQuotaDaily = false;
  let lastQuotaEscalated = false;
  let last: unknown;
  // Se usan los modelos que la propia cuenta tiene disponibles (siempre los últimos), no una lista fija
  const models = await discoverGeminiModels(req.apiKey);
  // Si todos los modelos agotaron su cupo hace poco, no se reintentan: se avisa ya para saltar a otra IA
  const rested = models.filter((m) => (exhaustedUntil.get(m) ?? 0) < Date.now()).slice(0, 5);
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
        consecutivePerMinuteHits.delete(req.apiKey!);
        return;
      } catch (err) {
        // Solo es «detenida por el usuario» si SU señal está marcada; un AbortError con esa señal
        // intacta es nuestro propio límite de tiempo al conectar (fallo de red), no un «Detener» real
        if (signal.aborted) throw aborted();
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
        // Fallo de red antes de recibir texto: se reintenta el mismo modelo una vez más (poco más se gana insistiendo)
        if (isNetworkError(err) && attempt < 1) {
          emit({ type: "status", message: "Se cortó la conexión; reintentando…" });
          await new Promise((r) => setTimeout(r, 1200));
          continue;
        }
        if (e.status === 429) {
          lastLimit = true;
          lastQuotaDaily = !!e.quota?.daily;
          if (!lastQuotaDaily) {
            // Si Google ya ha dicho "por minuto" dos veces seguidas DESPUÉS de haber esperado el tiempo que
            // él mismo indicó, el aviso no era preciso: el límite real se comporta como diario (no se libera
            // en un minuto), así que se avisa de eso y no se insiste más en poco tiempo.
            const hits = (consecutivePerMinuteHits.get(req.apiKey!) ?? 0) + 1;
            consecutivePerMinuteHits.set(req.apiKey!, hits);
            if (hits >= 2) {
              lastQuotaDaily = true;
              lastQuotaEscalated = true;
            }
          }
          // Por minuto: se reintenta pronto (lo que Google indique, o 70 s por defecto). Por día (o tras
          // repetirse): no hay nada que ganar insistiendo hasta que Google reinicie el cupo, así que no se
          // reintenta en horas.
          exhaustedUntil.set(model, Date.now() + (lastQuotaDaily ? 6 * 60 * 60_000 : (e.quota?.retryMs ?? 60_000) + 10_000));
        }
        break;
      }
    }
    const e = last as ProviderError;
    if (!(e instanceof ProviderError) || !e.tryNext) break;
  }
  if (lastLimit)
    throw quotaError(
      lastQuotaEscalated
        ? "Sigue dando el mismo límite de Google después de haber esperado: es probable que en realidad sea el cupo DIARIO (el aviso de «por minuto» de Google no siempre es exacto), no uno que se libere enseguida. Añade una clave gratuita de OpenRouter en Ajustes para seguir sin esperar, o vuelve a intentarlo más tarde."
        : lastQuotaDaily
          ? "Has agotado el cupo gratuito DIARIO de Google con este modelo (Google lo reinicia él solo, normalmente a medianoche hora del Pacífico de EE. UU., que puede ser por la mañana en España). Añade una clave gratuita de OpenRouter en Ajustes y la app se turnará sola mientras tanto."
          : "Google ha puesto un límite de peticiones por minuto; espera un minuto y vuelve a intentarlo. También puedes añadir una clave gratuita de OpenRouter en Ajustes y la app se turnará sola.",
    );
  if (isNetworkError(last)) throw networkFailedError(friendlyMessage(last));
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
    // OpenRouter no tiene aquí ninguna herramienta real de navegación o búsqueda conectada (a diferencia
    // de Gemini): aunque la petición pida webFetch/webSearch, se le dice la verdad para que no se la
    // invente ni finja haberla usado.
    { role: "system", content: systemText(req, false, false) },
  ];
  for (const t of history(req))
    messages.push({ role: t.role, content: t.text });
  const { before, after } = requestText(req, MAX_FILE_CHARS_OPENROUTER);
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
      "X-Title": "Ganx",
    },
    // Sin max_tokens, muchos backends gratuitos de OpenRouter usan un límite de salida por defecto muy
    // bajo (a veces 1-2 mil tokens), cortando la página a medias (un fichero completo y el resto vacío).
    // Se pide explícitamente un máximo generoso; si el modelo no llega a tanto, no pasa nada (no es obligatorio).
    body: JSON.stringify({ model, messages, stream: true, temperature: 0.3, max_tokens: 16000 }),
    signal: withConnectTimeout(signal),
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
        "La clave de OpenRouter no es válida. Causa más habitual: OpenRouter solo enseña la clave completa UNA VEZ, al crearla; si la copiaste después desde la lista de openrouter.ai/keys, ahí solo se ve una versión oculta (con puntos suspensivos) que no sirve. Crea una clave nueva y cópiala con el icono de copiar justo al crearla.",
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
      res.status === 404 || res.status === 429 || res.status >= 500 || isUpstreamCongestion(message),
      res.status,
    );
  }
  let emitted = 0;
  let finish: string | null = null;
  let usage: { input: number; output: number } | undefined;
  await midStream(
    signal,
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
  // Por si la clave se guardó antes de limpiar caracteres invisibles del copia-pega, se limpia también aquí
  req.apiKey = sanitizeKey(req.apiKey);
  const needsImages = (req.attachments ?? []).some((a) => a.type === "image");
  let last: unknown;
  for (const model of await freeOpenRouterModels(needsImages)) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        emit({ type: "status", message: `Generando con ${model} (gratis)…` });
        await openRouterOnce(model, req, emit, signal);
        return;
      } catch (err) {
        // Solo es «detenida por el usuario» si SU señal está marcada; un AbortError con esa señal
        // intacta es nuestro propio límite de tiempo al conectar (fallo de red), no un «Detener» real
        if (signal.aborted) throw aborted();
        last = err;
        // Fallo de red antes de recibir texto: se reintenta el mismo modelo una vez más
        if (isNetworkError(err) && attempt < 1) {
          emit({ type: "status", message: "Se cortó la conexión; reintentando…" });
          await new Promise((r) => setTimeout(r, 1200));
          continue;
        }
        break;
      }
    }
    if (!(last instanceof ProviderError) || !last.tryNext) break;
  }
  const e = last as ProviderError;
  if (e?.status === 429)
    throw quotaError(
      "Has usado el cupo gratuito de OpenRouter por hoy (50 peticiones al día). Vuelve mañana o usa la clave gratuita de Google.",
    );
  // Todos los modelos gratuitos probados estaban saturados en este momento (fallo del proveedor, no de la
  // petición): no tiene sentido repetir la misma petición tal cual, pero sí probar otra IA si hay otra configurada.
  if (e instanceof Error && isUpstreamCongestion(e.message))
    throw providerBusyError(
      "Los modelos gratuitos de OpenRouter están saturados ahora mismo (demasiados usuarios a la vez). Añade una clave gratuita de Google en Ajustes y la app se turnará sola, o inténtalo de nuevo en un momento.",
    );
  if (isNetworkError(last)) throw networkFailedError(friendlyMessage(last));
  throw last instanceof Error
    ? last
    : new Error("No se pudo usar la IA de OpenRouter.");
}
