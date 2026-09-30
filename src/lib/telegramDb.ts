/**
 * «Base de datos» en Telegram para los proyectos: añade al proyecto un script
 * (telegram-db.js) que envía a un chat de Telegram los datos de cualquier
 * formulario de la página, y expone window.TelegramDB.send() para enviar
 * datos desde código propio. Funciona sin servidor: la Bot API admite
 * peticiones desde el navegador.
 *
 * El token queda dentro del código de la página publicada; por eso se
 * recomienda un bot dedicado solo a recibir datos.
 */
import type { FileMap } from "../../shared/types";

export const TELEGRAM_DB_FILE = "telegram-db.js";
const SCRIPT_TAG = `<script src="${TELEGRAM_DB_FILE}"></script>`;
const TOKEN_RE = /\b(\d{6,}:[A-Za-z0-9_-]{30,})\b/;
// El separador no puede «comerse» el signo menos de los chats de grupos y canales (-100…)
const CHAT_RE = /(?:chat\s*id|id\s*del?\s*(?:chat|bot|canal|grupo)|chat|id)[^\d@-]{0,12}(-?\d{5,}|@[A-Za-z0-9_]{5,})/i;

export interface TelegramDbConfig {
  token: string;
  chatId: string;
}

export function isValidToken(token: string): boolean {
  return /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token.trim());
}
export function isValidChatId(chatId: string): boolean {
  return /^(-?\d+|@[A-Za-z0-9_]{5,})$/.test(chatId.trim());
}

/** ¿El mensaje pide conectar el proyecto con Telegram como base de datos? */
export function isTelegramDbRequest(text: string): boolean {
  return /telegram/i.test(text) && /(base\s+de\s+datos|conect|vincul|formulario|guard(a|ar)\s+(los\s+)?datos|recib)/i.test(text);
}

/** Extrae token y chat ID de un mensaje escrito por el usuario. */
export function parseTelegramCredentials(text: string): Partial<TelegramDbConfig> {
  const token = text.match(TOKEN_RE)?.[1];
  const rest = token ? text.replace(token, " ") : text;
  const chatId = rest.match(CHAT_RE)?.[1] ?? rest.match(/(?:^|\s)(-100\d{6,}|-?\d{6,})(?:\s|$|[.,;])/)?.[1];
  return { token, chatId };
}

export function readTelegramDbConfig(files: FileMap): TelegramDbConfig | null {
  const src = files[TELEGRAM_DB_FILE];
  if (!src) return null;
  const token = src.match(/token:\s*"([^"]+)"/)?.[1];
  const chatId = src.match(/chatId:\s*"([^"]+)"/)?.[1];
  return token && chatId ? { token, chatId } : null;
}

export function buildTelegramDbScript(cfg: TelegramDbConfig, projectName: string): string {
  const conf = JSON.stringify({ token: cfg.token.trim(), chatId: cfg.chatId.trim(), project: projectName }, null, 2)
    .replace(/"(\w+)":/g, "$1:");
  return `/*
 * Base de datos en Telegram (generado por DevStudio Pro).
 * Cada formulario de la página envía sus datos a tu chat de Telegram.
 * - Para que un formulario NO se envíe, añádele data-telegram="off".
 * - Para enviar datos desde tu propio código: TelegramDB.send({ campo: "valor" }, "Título").
 * Aviso: el token es visible en el código de la página. Usa un bot dedicado solo a esto.
 */
(function () {
  "use strict";
  var CONFIG = ${conf};
  var API = "https://api.telegram.org/bot" + CONFIG.token + "/";
  var MAX_TEXT = 3900;

  function call(method, body) {
    var isForm = body instanceof FormData;
    return fetch(API + method, {
      method: "POST",
      headers: isForm ? undefined : { "content-type": "application/json" },
      body: isForm ? body : JSON.stringify(body)
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) throw new Error(j.description || "Error de Telegram");
      return j.result;
    });
  }

  function chunks(text) {
    var out = [];
    for (var i = 0; i < text.length; i += MAX_TEXT) out.push(text.slice(i, i + MAX_TEXT));
    return out.length ? out : [""];
  }

  function format(title, data) {
    var lines = ["📩 " + title, "🗂 " + (CONFIG.project || document.title || location.hostname), ""];
    Object.keys(data).forEach(function (k) {
      var v = data[k];
      if (v === undefined || v === null || v === "") return;
      lines.push("• " + k + ": " + (Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v)));
    });
    lines.push("", "🕒 " + new Date().toLocaleString());
    if (/^https?:/.test(location.protocol)) lines.push("🌐 " + location.href);
    return lines.join("\\n");
  }

  function send(data, title) {
    var text = format(title || "Nuevos datos", data || {});
    return chunks(text).reduce(function (p, part) {
      return p.then(function () { return call("sendMessage", { chat_id: CONFIG.chatId, text: part, disable_web_page_preview: true }); });
    }, Promise.resolve());
  }

  function sendFile(file, caption) {
    var fd = new FormData();
    fd.append("chat_id", CONFIG.chatId);
    fd.append("document", file, file.name);
    if (caption) fd.append("caption", caption.slice(0, 1000));
    return call("sendDocument", fd);
  }

  function labelFor(form, el) {
    var id = el.getAttribute("id");
    var label = (id && form.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]')) || el.closest("label");
    var text = label ? label.textContent.replace(/\\s+/g, " ").trim() : "";
    return text || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.name || id || "campo";
  }

  function collect(form) {
    var data = {};
    var files = [];
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name && !el.id) return;
      var type = (el.type || "").toLowerCase();
      if (["submit", "button", "reset", "image"].indexOf(type) !== -1 || el.disabled) return;
      if (type === "password") return; // nunca se envían contraseñas
      var key = labelFor(form, el);
      if (type === "file") { Array.prototype.forEach.call(el.files || [], function (f) { files.push(f); }); return; }
      if ((type === "checkbox" || type === "radio") && !el.checked) return;
      var value = type === "checkbox" && el.value === "on" ? "Sí" : el.value;
      if (type === "select-multiple") value = Array.prototype.filter.call(el.options, function (o) { return o.selected; }).map(function (o) { return o.text; });
      if (data[key] !== undefined) data[key] = [].concat(data[key], value); else data[key] = value;
    });
    return { data: data, files: files };
  }

  function status(form, text, ok) {
    var el = form.querySelector("[data-telegram-status]");
    if (!el) {
      el = document.createElement("p");
      el.setAttribute("data-telegram-status", "");
      el.setAttribute("role", "status");
      el.style.cssText = "margin:10px 0 0;font:14px/1.4 system-ui,sans-serif";
      form.appendChild(el);
    }
    el.style.color = ok ? "#1f9d63" : "#d64545";
    el.textContent = text;
  }

  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!(form instanceof HTMLFormElement) || form.getAttribute("data-telegram") === "off") return;
    e.preventDefault();
    if (!form.checkValidity()) { form.reportValidity(); return; }
    var buttons = form.querySelectorAll("button, input[type=submit]");
    Array.prototype.forEach.call(buttons, function (b) { b.disabled = true; });
    var collected = collect(form);
    var title = "Formulario: " + (form.getAttribute("aria-label") || form.getAttribute("name") || form.id || (form.querySelector("h1,h2,h3,legend") || {}).textContent || "sin nombre").toString().trim();
    status(form, "Enviando…", true);
    send(collected.data, title)
      .then(function () {
        return collected.files.slice(0, 5).reduce(function (p, f) {
          return p.then(function () { return f.size <= 50 * 1024 * 1024 ? sendFile(f, title) : null; });
        }, Promise.resolve());
      })
      .then(function () {
        status(form, form.getAttribute("data-telegram-ok") || "✓ ¡Enviado! Gracias.", true);
        form.reset();
        form.dispatchEvent(new CustomEvent("telegram:sent", { bubbles: true }));
      })
      .catch(function (err) {
        status(form, form.getAttribute("data-telegram-error") || "✗ No se pudo enviar. Inténtalo de nuevo.", false);
        console.error("TelegramDB:", err && err.message);
      })
      .then(function () { Array.prototype.forEach.call(buttons, function (b) { b.disabled = false; }); });
  }, true);

  window.TelegramDB = { send: send, sendFile: sendFile };
})();
`;
}

function htmlPages(files: FileMap): string[] {
  return Object.keys(files).filter((p) => /\.html?$/i.test(p));
}

/** Añade (o actualiza) la conexión con Telegram en todas las páginas del proyecto. */
export function connectTelegramDb(files: FileMap, cfg: TelegramDbConfig, projectName: string): FileMap {
  const updated: FileMap = { [TELEGRAM_DB_FILE]: buildTelegramDbScript(cfg, projectName) };
  for (const page of htmlPages(files)) {
    const html = files[page];
    if (html.includes(TELEGRAM_DB_FILE)) continue;
    const depth = page.split("/").length - 1;
    const tag = SCRIPT_TAG.replace(TELEGRAM_DB_FILE, "../".repeat(depth) + TELEGRAM_DB_FILE);
    updated[page] = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `  ${tag}\n</body>`) : `${html}\n${tag}\n`;
  }
  return updated;
}

/** Quita la conexión: devuelve las páginas modificadas y el fichero a borrar. */
export function disconnectTelegramDb(files: FileMap): { updated: FileMap; deleted: string[] } {
  const updated: FileMap = {};
  for (const page of htmlPages(files)) {
    const html = files[page];
    const cleaned = html.replace(/\s*<script\s+src="(?:\.\.\/)*telegram-db\.js"><\/script>/gi, "");
    if (cleaned !== html) updated[page] = cleaned;
  }
  return { updated, deleted: TELEGRAM_DB_FILE in files ? [TELEGRAM_DB_FILE] : [] };
}
