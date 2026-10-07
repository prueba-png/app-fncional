import type {
  ChatRequest,
  ChatStreamEvent,
  IngestOptions,
  IngestResult,
  TelegramBackupResponse,
  TelegramCredentials,
  TelegramTestResponse,
} from "../../shared/types";

import { browserTelegramBackup, browserTelegramRestore, browserTelegramTest } from "./telegramBrowser";
import { blobToBase64 } from "./util";

const HEADERS = { "content-type": "application/json", "x-devstudio": "1" };

async function readError(res: Response): Promise<Error> {
  const json = (await res.json().catch(() => null)) as { error?: string } | null;
  return new Error(json?.error ?? `Error HTTP ${res.status}`);
}

async function request(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", headers: HEADERS, body: JSON.stringify(body), signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new Error("No se pudo contactar con el servidor local. ¿Está en marcha `npm run dev`?");
  }
  if (!res.ok) throw await readError(res);
  return res;
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return (await (await request(path, body, signal)).json()) as T;
}

export interface HealthInfo {
  ok: boolean;
  version: string;
  hasEnvApiKey: boolean;
  defaultModel: string;
  /** false en la versión publicada: la IA se llama directamente desde el navegador */
  llm?: boolean;
  hosted?: boolean;
}

export async function health(): Promise<HealthInfo | null> {
  try {
    const res = await fetch("/api/health");
    return res.ok ? ((await res.json()) as HealthInfo) : null;
  } catch {
    return null;
  }
}

export const ingest = (opts: IngestOptions, signal?: AbortSignal) => post<IngestResult>("/api/ingest", opts, signal);

/** Sin servidor (versión de un solo archivo), Telegram se llama directamente desde el navegador. */
let serverless = false;
export function setServerless(value: boolean) {
  serverless = value;
}

export const telegramTest = (c: TelegramCredentials) =>
  serverless ? browserTelegramTest(c) : post<TelegramTestResponse>("/api/telegram/test", c);

export async function telegramBackup(c: TelegramCredentials, filename: string, caption: string, blob: Blob): Promise<TelegramBackupResponse> {
  if (serverless) return browserTelegramBackup(c, filename, caption, blob);
  return post<TelegramBackupResponse>("/api/telegram/backup", { ...c, filename, caption, data: await blobToBase64(blob) });
}

export async function telegramRestore(token: string, fileId: string): Promise<Blob> {
  if (serverless) return browserTelegramRestore(token, fileId);
  return (await request("/api/telegram/restore", { token, fileId })).blob();
}

/** Envía una petición al asistente y procesa el flujo SSE evento a evento. */
export async function streamChat(req: ChatRequest, onEvent: (e: ChatStreamEvent) => void, signal: AbortSignal): Promise<void> {
  const res = await request("/api/llm/chat", req, signal);
  if (!res.body) throw new Error("Respuesta vacía del servidor.");
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = raw
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n");
      if (data) onEvent(JSON.parse(data) as ChatStreamEvent);
    }
  }
}
