import { useEffect, useState } from "react";
import { useStudio } from "../store/studio";
import { telegramTest } from "../lib/api";
import {
  TELEGRAM_DB_FILE,
  connectTelegramDb,
  disconnectTelegramDb,
  isValidChatId,
  isValidToken,
  readTelegramDbConfig,
} from "../lib/telegramDb";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";

/** Conecta el proyecto actual con Telegram: los formularios de la página envían sus datos a tu chat. */
export function TelegramDbDialog() {
  const state = useStudio((s) => s.telegramDb);
  const project = useStudio((s) => s.project);
  const settings = useStudio((s) => s.settings);
  const { closeTelegramDb, applyChanges, toast } = useStudio.getState();
  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [busy, setBusy] = useState<"" | "test" | "connect">("");
  const [result, setResult] = useState("");

  const current = project ? readTelegramDbConfig(project.files) : null;

  useEffect(() => {
    if (!state.open) return;
    setToken(state.token ?? current?.token ?? "");
    setChatId(state.chatId ?? current?.chatId ?? "");
    setResult("");
  }, [state.open]);

  if (!project) return null;
  const valid = isValidToken(token) && isValidChatId(chatId);

  const test = async () => {
    setBusy("test");
    setResult("");
    try {
      const r = await telegramTest({ token: token.trim(), chatId: chatId.trim() });
      setResult(`✓ Funciona: el bot @${r.bot.username} escribe en «${r.chat.title}». Te ha enviado un mensaje de prueba.`);
    } catch (err) {
      setResult(`✗ ${(err as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const connect = async () => {
    if (!valid) return;
    setBusy("connect");
    try {
      const updated = connectTelegramDb(project.files, { token, chatId }, project.name);
      await applyChanges(updated, [], "Conectado a la base de datos de Telegram", "dependency");
      toast("Proyecto conectado: los formularios enviarán sus datos a tu Telegram", "success");
      closeTelegramDb();
    } catch (err) {
      toast(`No se pudo conectar: ${(err as Error).message}`, "error");
    } finally {
      setBusy("");
    }
  };

  const disconnect = async () => {
    const { updated, deleted } = disconnectTelegramDb(project.files);
    await applyChanges(updated, deleted, "Desconectado de la base de datos de Telegram", "dependency");
    toast("Proyecto desconectado de Telegram", "success");
    closeTelegramDb();
  };

  const hasForms = Object.entries(project.files).some(([p, c]) => /\.html?$/i.test(p) && /<form\b/i.test(c));

  return (
    <Dialog
      title="Base de datos en Telegram"
      open={state.open}
      onClose={closeTelegramDb}
      footer={
        <>
          {current && (
            <button className="btn danger" onClick={() => void disconnect()} style={{ marginRight: "auto" }}>
              Desconectar
            </button>
          )}
          <button className="btn" onClick={() => void test()} disabled={!valid || !!busy} title="Envía un mensaje de prueba a tu chat">
            {busy === "test" ? <span className="spinner" /> : <Icon name="bolt" />} Probar
          </button>
          <button className="btn primary" onClick={() => void connect()} disabled={!valid || !!busy}>
            {busy === "connect" ? <span className="spinner" /> : <Icon name="database" />} {current ? "Actualizar" : "Conectar proyecto"}
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        Todo lo que la gente envíe en los <b>formularios</b> de «{project.name}» (contacto, reservas, pedidos, registros…) te llegará como mensaje a tu
        chat de Telegram. Los archivos adjuntos llegan como documentos.
      </p>
      {current && (
        <div className="notice" style={{ marginBottom: 12 }}>
          ✓ Este proyecto ya está conectado (chat {current.chatId}). Puedes cambiar los datos y pulsar «Actualizar».
        </div>
      )}
      {!hasForms && (
        <div className="notice warning" style={{ marginBottom: 12 }}>
          Esta página todavía no tiene formularios. Después de conectarla, pide por ejemplo «añade un formulario de contacto» y sus datos también llegarán a
          Telegram.
        </div>
      )}
      {settings.telegramToken && settings.telegramChatId && (
        <button
          className="btn sm"
          style={{ marginBottom: 12 }}
          onClick={() => {
            setToken(settings.telegramToken);
            setChatId(settings.telegramChatId);
          }}
        >
          Usar el mismo bot que en Ajustes
        </button>
      )}
      <label className="field">
        <span>Token del bot (te lo da @BotFather)</span>
        <input id="tgdb-token" className="input mono" autoComplete="off" placeholder="123456789:AA…" value={token} onChange={(e) => setToken(e.target.value)} />
      </label>
      <label className="field">
        <span>ID del chat donde recibir los datos (te lo da @userinfobot)</span>
        <input id="tgdb-chat" className="input mono" autoComplete="off" placeholder="123456789 o -100…" value={chatId} onChange={(e) => setChatId(e.target.value)} />
      </label>
      {result && (
        <p className="small" style={{ color: result.startsWith("✓") ? "var(--success)" : "var(--danger)" }}>
          {result}
        </p>
      )}
      <details className="block">
        <summary>¿Cómo consigo el token y el ID?</summary>
        <div>
          <ol className="key-steps">
            <li>En Telegram, escribe a @BotFather, envía /newbot y sigue los pasos: te dará el token.</li>
            <li>Abre tu bot nuevo y pulsa «Iniciar» (o escríbele cualquier mensaje).</li>
            <li>Escribe a @userinfobot: te responde con tu ID (un número).</li>
          </ol>
        </div>
      </details>
      <div className="notice warning">
        Importante: el token queda dentro del código de tu página ({TELEGRAM_DB_FILE}), así que alguien que mire ese código podría usar el bot. Usa un bot
        creado <b>solo</b> para recibir formularios, distinto del de tus copias de seguridad.
      </div>
    </Dialog>
  );
}
