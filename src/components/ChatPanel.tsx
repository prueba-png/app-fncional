import { useEffect, useRef, useState } from "react";
import { parseFileBlocks } from "../../shared/fileBlocks";
import { useChat } from "../store/chat";
import { useStudio } from "../store/studio";
import type { ChatMessage } from "../db/db";
import { Icon } from "./Icon";
import { ServerNotice } from "./ServerNotice";

const SUGGESTIONS = [
  "Añade un formulario de contacto accesible con validación",
  "Haz el layout responsive para móvil",
  "Convierte los colores en variables CSS y añade modo oscuro",
  "Mejora la accesibilidad (foco visible, contraste, landmarks)",
  "Añade una barra de navegación fija con menú hamburguesa",
];

function Prose({ text }: { text: string }) {
  // Renderizado mínimo de `código` en línea, sin HTML arbitrario
  const parts = text.split(/(`[^`\n]+`)/g);
  return (
    <div className="prose">
      {parts.map((p, i) => (p.startsWith("`") && p.endsWith("`") && p.length > 2 ? <code key={i}>{p.slice(1, -1)}</code> : <span key={i}>{p}</span>))}
    </div>
  );
}

function AssistantMessage({ m }: { m: ChatMessage }) {
  const versions = useStudio((s) => s.versions);
  const { restoreVersion, setTab, ask } = useStudio.getState();
  const parsed = parseFileBlocks(m.content);
  const idx = m.meta?.versionId ? versions.findIndex((v) => v.id === m.meta!.versionId) : -1;
  const previous = idx >= 0 ? versions[idx + 1] : undefined;
  return (
    <div className="msg assistant">
      {parsed.prose ? <Prose text={parsed.prose} /> : !m.meta?.error && <span className="muted">(sin explicación)</span>}
      {m.meta?.error && <div className="notice danger" style={{ marginTop: 6 }}>{m.meta.error}</div>}
      <div className="foot">
        {m.meta?.changed?.map((f) => (
          <span key={f} className="chip add">
            <Icon name="file" size={11} /> {f}
          </span>
        ))}
        {m.meta?.deleted?.map((f) => (
          <span key={f} className="chip del">
            <Icon name="trash" size={11} /> {f}
          </span>
        ))}
        {m.meta?.usage && (
          <span title={m.meta.model}>
            {m.meta.usage.input.toLocaleString("es")} → {m.meta.usage.output.toLocaleString("es")} tokens
          </span>
        )}
        {previous && (
          <button
            className="btn sm ghost"
            title="Restaura la versión anterior a este cambio"
            onClick={async () => {
              const ok = await ask({ title: "Revertir cambios", message: "Se restaurará la versión anterior a esta respuesta.", confirmLabel: "Revertir" });
              if (ok !== null) await restoreVersion(previous.id);
            }}
          >
            <Icon name="history" size={12} /> Revertir
          </button>
        )}
        {idx >= 0 && (
          <button className="btn sm ghost" onClick={() => setTab("history")}>
            Ver diff
          </button>
        )}
      </div>
    </div>
  );
}

export function ChatPanel() {
  const { messages, streaming, streamText, status } = useChat();
  const { send, stop, clear } = useChat.getState();
  const activeFile = useStudio((s) => s.project?.activeFile);
  const ai = useStudio((s) => s.ai);
  const [input, setInput] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  // Nuevo mensaje: siempre al final. Mientras la IA escribe: solo si ya estabas al final (no te mueve si estás leyendo)
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);
  useEffect(() => {
    const el = logRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 140) el.scrollTop = el.scrollHeight;
  }, [streamText]);

  const submit = () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    void send(text);
  };

  const live = streaming ? parseFileBlocks(streamText) : null;
  const inProgress = streaming ? [...streamText.matchAll(/<file\s+path="([^"]+)"/g)].map((m) => m[1]) : [];

  return (
    <div className="tool-body flush">
      <div className="chat-log" ref={logRef} aria-live="polite">
        {ai !== "claude" && <ServerNotice feature="el asistente de código" worksServerless />}
        {messages.length === 0 && !streaming && (
          <div className="empty">
            <Icon name="sparkles" size={28} />
            <p>
              Pide cambios sobre el código del proyecto. El asistente edita los ficheros directamente y cada respuesta crea una versión que
              puedes revertir.
            </p>
            <div className="suggestions" style={{ justifyContent: "center" }}>
              {SUGGESTIONS.map((s) => (
                <button key={s} className="suggestion" onClick={() => setInput(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="msg user">
              <Prose text={m.content} />
              {m.meta?.attachments?.length ? (
                <div className="foot">
                  {m.meta.attachments.map((a) => (
                    <span key={a} className="chip">
                      <Icon name="image" size={11} /> {a}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <AssistantMessage key={m.id} m={m} />
          ),
        )}
        {streaming && (
          <div className="msg assistant">
            {live?.prose ? <Prose text={live.prose} /> : <span className="muted">{status || "Pensando…"}</span>}
            <div className="foot">
              <span className="spinner" />
              {inProgress.length ? (
                <div className="typing-files">
                  {inProgress.map((f, i) => (
                    <span key={f + i} className="chip">
                      <Icon name="file" size={11} /> {f} {i === inProgress.length - 1 && live?.incomplete ? "…" : "✓"}
                    </span>
                  ))}
                </div>
              ) : (
                <span>{status}</span>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="chat-compose">
        <textarea
          className="textarea"
          placeholder={`Describe el cambio… (Enter para enviar, Shift+Enter nueva línea)${activeFile ? `\nFichero activo: ${activeFile}` : ""}`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          aria-label="Mensaje para el asistente"
        />
        <div className="row">
          <button
            className="btn sm ghost"
            disabled={streaming || messages.length === 0}
            onClick={async () => {
              const ok = await useStudio.getState().ask({
                title: "Borrar conversación",
                message: "El código y el historial de versiones no se modifican.",
                confirmLabel: "Borrar",
                danger: true,
              });
              if (ok !== null) await clear();
            }}
          >
            <Icon name="trash" size={12} /> Limpiar chat
          </button>
          <div className="grow" />
          {streaming ? (
            <button className="btn danger" onClick={stop}>
              <Icon name="stop" /> Detener
            </button>
          ) : (
            <button className="btn primary" onClick={submit} disabled={!input.trim()}>
              <Icon name="send" /> Enviar
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
