/**
 * Versión de un solo archivo (sin servidor): el navegador habla directamente
 * con la Bot API de Telegram, que admite peticiones desde páginas web (CORS).
 */
import type { TelegramBackupResponse, TelegramCredentials, TelegramTestResponse } from "../../shared/types";

const API = "https://api.telegram.org";

function validate(token: string, chatId?: string) {
  if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token.trim())) throw new Error("Token de bot no válido (formato 123456:ABC…).");
  if (chatId !== undefined && !/^(-?\d+|@[A-Za-z0-9_]{5,})$/.test(chatId.trim()))
    throw new Error("Chat ID no válido (número, -100… para canales/grupos, o @canal).");
}

async function call<T>(token: string, method: string, body: Record<string, unknown> | FormData): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}/bot${token.trim()}/${method}`, {
      method: "POST",
      body: body instanceof FormData ? body : JSON.stringify(body),
      headers: body instanceof FormData ? undefined : { "content-type": "application/json" },
    });
  } catch {
    throw new Error("No se pudo contactar con Telegram. Revisa tu conexión.");
  }
  const json = (await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }))) as { ok: boolean; result?: T; description?: string };
  if (!json.ok) throw new Error(`Telegram: ${json.description ?? "error desconocido"}`);
  return json.result as T;
}

export async function browserTelegramTest(c: TelegramCredentials): Promise<TelegramTestResponse> {
  validate(c.token, c.chatId);
  const me = await call<{ id: number; username: string; first_name: string }>(c.token, "getMe", {});
  const chat = await call<{ id: number; title?: string; username?: string; first_name?: string; type: string }>(c.token, "getChat", { chat_id: c.chatId.trim() });
  await call(c.token, "sendMessage", {
    chat_id: chat.id,
    text: "✅ DevStudio Pro conectado. Este chat se usará como repositorio de copias de seguridad.",
    disable_notification: true,
  });
  return {
    bot: { id: me.id, username: me.username, firstName: me.first_name },
    chat: { id: chat.id, title: chat.title ?? chat.username ?? chat.first_name ?? String(chat.id), type: chat.type },
  };
}

export async function browserTelegramBackup(c: TelegramCredentials, filename: string, caption: string, blob: Blob): Promise<TelegramBackupResponse> {
  validate(c.token, c.chatId);
  if (blob.size > 50 * 1024 * 1024) throw new Error("El paquete supera los 50 MB permitidos por Telegram.");
  const form = new FormData();
  form.append("chat_id", c.chatId.trim());
  form.append("document", blob, filename.replace(/[^\w.\-]+/g, "_").slice(0, 120));
  if (caption) form.append("caption", caption.slice(0, 1024));
  form.append("disable_notification", "true");
  const msg = await call<{
    message_id: number;
    date: number;
    chat: { title?: string; username?: string };
    document?: { file_id: string; file_unique_id: string; file_size?: number };
  }>(c.token, "sendDocument", form);
  if (!msg.document) throw new Error("Telegram no devolvió el documento enviado.");
  return {
    messageId: msg.message_id,
    fileId: msg.document.file_id,
    fileUniqueId: msg.document.file_unique_id,
    fileSize: msg.document.file_size ?? blob.size,
    chatTitle: msg.chat.title ?? msg.chat.username,
    date: msg.date,
  };
}

export async function browserTelegramRestore(token: string, fileId: string): Promise<Blob> {
  validate(token);
  const file = await call<{ file_path?: string }>(token, "getFile", { file_id: fileId.trim() });
  if (!file.file_path) throw new Error("El fichero no está disponible para descarga (límite 20 MB de Telegram).");
  let res: Response;
  try {
    res = await fetch(`${API}/file/bot${token.trim()}/${file.file_path}`);
  } catch {
    throw new Error("Telegram no permite descargar el fichero desde el navegador. Descárgalo desde el chat de Telegram e impórtalo con «Importar ZIP».");
  }
  if (!res.ok) throw new Error(`Descarga fallida (HTTP ${res.status}).`);
  return res.blob();
}
