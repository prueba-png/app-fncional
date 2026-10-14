/**
 * Capa de almacenamiento descentralizada: usa la Bot API oficial de Telegram
 * como repositorio personal de copias de seguridad (ficheros ZIP).
 * El token nunca se persiste en el servidor ni se escribe en logs.
 * La usan el servidor local (Express) y la función de Netlify.
 */
import type { TelegramBackupResponse, TelegramTestResponse } from "../../shared/types";

/** Permite usar un servidor Bot API propio (https://github.com/tdlib/telegram-bot-api). */
const api = () => (process.env.TELEGRAM_API_URL || "https://api.telegram.org").replace(/\/+$/, "");
const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;
const MAX_UPLOAD = 50 * 1024 * 1024; // límite de la Bot API para sendDocument
const MAX_DOWNLOAD = 20 * 1024 * 1024; // límite de la Bot API para getFile

export class TelegramError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function scrubToken(text: string, token: string): string {
  return token ? text.split(token).join("<token>") : text;
}

export function validateToken(token: unknown, chatId?: unknown): string {
  if (typeof token !== "string" || !TOKEN_RE.test(token.trim())) throw new TelegramError("Token de bot no válido (formato 123456:ABC…).");
  if (chatId !== undefined && (typeof chatId !== "string" || !/^(-?\d+|@[A-Za-z0-9_]{5,})$/.test(chatId.trim())))
    throw new TelegramError("Chat ID no válido (número, -100… para canales/grupos, o @canal).");
  return token.trim();
}

async function callApi<T>(token: string, method: string, body?: Record<string, unknown> | FormData, timeoutMs = 120_000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${api()}/bot${token}/${method}`, {
      method: "POST",
      body: body instanceof FormData ? body : JSON.stringify(body ?? {}),
      headers: body instanceof FormData ? undefined : { "content-type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new TelegramError(`No se pudo contactar con Telegram: ${scrubToken((err as Error).message, token)}`, 502);
  }
  const json = (await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))) as {
    ok: boolean;
    result?: T;
    description?: string;
  };
  if (!json.ok) throw new TelegramError(`Telegram: ${scrubToken(json.description ?? "error desconocido", token)}`, res.status === 401 ? 401 : 502);
  return json.result as T;
}

interface TgUser { id: number; username: string; first_name: string }
interface TgChat { id: number; title?: string; username?: string; first_name?: string; type: string }
interface TgMessage { message_id: number; date: number; chat: TgChat; document?: { file_id: string; file_unique_id: string; file_size?: number } }

export async function telegramTest(body: { token?: unknown; chatId?: unknown }): Promise<TelegramTestResponse> {
  const token = validateToken(body.token, body.chatId);
  const me = await callApi<TgUser>(token, "getMe");
  const chat = await callApi<TgChat>(token, "getChat", { chat_id: String(body.chatId).trim() });
  await callApi(token, "sendMessage", {
    chat_id: chat.id,
    text: "✅ Ganx conectado. Este chat se usará como repositorio de copias de seguridad.",
    disable_notification: true,
  });
  return {
    bot: { id: me.id, username: me.username, firstName: me.first_name },
    chat: { id: chat.id, title: chat.title ?? chat.username ?? chat.first_name ?? String(chat.id), type: chat.type },
  };
}

export async function telegramBackup(
  body: { token?: unknown; chatId?: unknown; filename?: string; caption?: string; data?: string },
  maxBytes = MAX_UPLOAD,
): Promise<TelegramBackupResponse> {
  const token = validateToken(body.token, body.chatId);
  if (!body.data || typeof body.data !== "string") throw new TelegramError("No hay datos que respaldar.");
  const buffer = Buffer.from(body.data, "base64");
  if (buffer.byteLength > maxBytes)
    throw new TelegramError(`El paquete supera los ${Math.floor(maxBytes / 1024 / 1024)} MB permitidos. Respalda los proyectos de uno en uno.`, 413);
  const safeName = (body.filename ?? "backup.zip").replace(/[^\w.\-]+/g, "_").slice(0, 120);

  const form = new FormData();
  form.append("chat_id", String(body.chatId).trim());
  form.append("document", new Blob([buffer], { type: "application/zip" }), safeName);
  if (body.caption) form.append("caption", String(body.caption).slice(0, 1024));
  form.append("disable_notification", "true");

  const msg = await callApi<TgMessage>(token, "sendDocument", form);
  if (!msg.document) throw new TelegramError("Telegram no devolvió el documento enviado.", 502);
  return {
    messageId: msg.message_id,
    fileId: msg.document.file_id,
    fileUniqueId: msg.document.file_unique_id,
    fileSize: msg.document.file_size ?? buffer.byteLength,
    chatTitle: msg.chat.title ?? msg.chat.username,
    date: msg.date,
  };
}

export async function telegramRestore(body: { token?: unknown; fileId?: unknown }, maxBytes = MAX_DOWNLOAD): Promise<Buffer> {
  const token = validateToken(body.token);
  const fileId = String(body.fileId ?? "").trim();
  if (!/^[\w-]{10,}$/.test(fileId)) throw new TelegramError("file_id no válido.");
  const file = await callApi<{ file_path?: string; file_size?: number }>(token, "getFile", { file_id: fileId });
  if (!file.file_path) throw new TelegramError("El fichero no está disponible para descarga (límite 20 MB de la Bot API).", 404);
  if ((file.file_size ?? 0) > maxBytes) throw new TelegramError(`El fichero supera los ${Math.floor(maxBytes / 1024 / 1024)} MB descargables.`, 413);
  let dl: Response;
  try {
    dl = await fetch(`${api()}/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(120_000) });
  } catch (err) {
    throw new TelegramError(`Descarga fallida: ${scrubToken((err as Error).message, token)}`, 502);
  }
  if (!dl.ok) throw new TelegramError(`Descarga fallida (HTTP ${dl.status}).`, 502);
  return Buffer.from(await dl.arrayBuffer());
}
