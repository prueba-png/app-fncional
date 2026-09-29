/**
 * Capa de almacenamiento descentralizada: usa la Bot API oficial de Telegram
 * como repositorio personal de copias de seguridad (ficheros ZIP).
 * El token nunca se persiste en el servidor ni se escribe en logs.
 */
import { Router, type Response } from "express";
import type { TelegramBackupResponse, TelegramTestResponse } from "../../shared/types";

export const telegramRouter = Router();

/** Permite usar un servidor Bot API propio (https://github.com/tdlib/telegram-bot-api). */
const API = (process.env.TELEGRAM_API_URL || "https://api.telegram.org").replace(/\/+$/, "");
const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;
const MAX_UPLOAD = 50 * 1024 * 1024; // límite de la Bot API para sendDocument
const MAX_DOWNLOAD = 20 * 1024 * 1024; // límite de la Bot API para getFile

class TelegramError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

function scrub(text: string, token: string): string {
  return token ? text.split(token).join("<token>") : text;
}

function validate(token: unknown, chatId?: unknown): string {
  if (typeof token !== "string" || !TOKEN_RE.test(token.trim())) throw new TelegramError("Token de bot no válido (formato 123456:ABC…).");
  if (chatId !== undefined && (typeof chatId !== "string" || !/^(-?\d+|@[A-Za-z0-9_]{5,})$/.test(chatId.trim())))
    throw new TelegramError("Chat ID no válido (número, -100… para canales/grupos, o @canal).");
  return token.trim();
}

async function callApi<T>(token: string, method: string, body?: Record<string, unknown> | FormData): Promise<T> {
  let res: globalThis.Response;
  try {
    res = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      body: body instanceof FormData ? body : JSON.stringify(body ?? {}),
      headers: body instanceof FormData ? undefined : { "content-type": "application/json" },
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw new TelegramError(`No se pudo contactar con Telegram: ${scrub((err as Error).message, token)}`, 502);
  }
  const json = (await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))) as {
    ok: boolean;
    result?: T;
    description?: string;
  };
  if (!json.ok) throw new TelegramError(`Telegram: ${scrub(json.description ?? "error desconocido", token)}`, res.status === 401 ? 401 : 502);
  return json.result as T;
}

function fail(res: Response, err: unknown, token = "") {
  const status = err instanceof TelegramError ? err.status : 500;
  res.status(status).json({ error: scrub((err as Error).message, token) });
}

interface TgUser { id: number; username: string; first_name: string }
interface TgChat { id: number; title?: string; username?: string; first_name?: string; type: string }
interface TgMessage { message_id: number; date: number; chat: TgChat; document?: { file_id: string; file_unique_id: string; file_size?: number } }

telegramRouter.post("/test", async (req, res) => {
  let token = "";
  try {
    token = validate(req.body?.token, req.body?.chatId);
    const me = await callApi<TgUser>(token, "getMe");
    const chat = await callApi<TgChat>(token, "getChat", { chat_id: String(req.body.chatId).trim() });
    await callApi(token, "sendMessage", {
      chat_id: chat.id,
      text: "✅ DevStudio Pro conectado. Este chat se usará como repositorio de copias de seguridad.",
      disable_notification: true,
    });
    const out: TelegramTestResponse = {
      bot: { id: me.id, username: me.username, firstName: me.first_name },
      chat: { id: chat.id, title: chat.title ?? chat.username ?? chat.first_name ?? String(chat.id), type: chat.type },
    };
    res.json(out);
  } catch (err) {
    fail(res, err, token);
  }
});

telegramRouter.post("/backup", async (req, res) => {
  let token = "";
  try {
    token = validate(req.body?.token, req.body?.chatId);
    const { filename, caption, data } = req.body as { filename?: string; caption?: string; data?: string };
    if (!data || typeof data !== "string") throw new TelegramError("No hay datos que respaldar.");
    const buffer = Buffer.from(data, "base64");
    if (buffer.byteLength > MAX_UPLOAD) throw new TelegramError("El paquete supera los 50 MB permitidos por la Bot API.", 413);
    const safeName = (filename ?? "backup.zip").replace(/[^\w.\-]+/g, "_").slice(0, 120);

    const form = new FormData();
    form.append("chat_id", String(req.body.chatId).trim());
    form.append("document", new Blob([buffer], { type: "application/zip" }), safeName);
    if (caption) form.append("caption", String(caption).slice(0, 1024));
    form.append("disable_notification", "true");

    const msg = await callApi<TgMessage>(token, "sendDocument", form);
    if (!msg.document) throw new TelegramError("Telegram no devolvió el documento enviado.", 502);
    const out: TelegramBackupResponse = {
      messageId: msg.message_id,
      fileId: msg.document.file_id,
      fileUniqueId: msg.document.file_unique_id,
      fileSize: msg.document.file_size ?? buffer.byteLength,
      chatTitle: msg.chat.title ?? msg.chat.username,
      date: msg.date,
    };
    res.json(out);
  } catch (err) {
    fail(res, err, token);
  }
});

telegramRouter.post("/restore", async (req, res) => {
  let token = "";
  try {
    token = validate(req.body?.token);
    const fileId = String(req.body?.fileId ?? "").trim();
    if (!/^[\w-]{10,}$/.test(fileId)) throw new TelegramError("file_id no válido.");
    const file = await callApi<{ file_path?: string; file_size?: number }>(token, "getFile", { file_id: fileId });
    if (!file.file_path) throw new TelegramError("El fichero no está disponible para descarga (límite 20 MB de la Bot API).", 404);
    if ((file.file_size ?? 0) > MAX_DOWNLOAD) throw new TelegramError("El fichero supera los 20 MB descargables por la Bot API.", 413);
    const dl = await fetch(`${API}/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(120_000) });
    if (!dl.ok) throw new TelegramError(`Descarga fallida (HTTP ${dl.status}).`, 502);
    const buf = Buffer.from(await dl.arrayBuffer());
    res.setHeader("content-type", "application/zip");
    res.setHeader("content-length", String(buf.byteLength));
    res.end(buf);
  } catch (err) {
    fail(res, err, token);
  }
});
