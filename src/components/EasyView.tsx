import { useEffect, useRef, useState } from "react";
import { parseFileBlocks } from "../../shared/fileBlocks";
import { useEasy, normalizeUrl } from "../store/easy";
import { useStudio, aiAvailable, needsApiKey } from "../store/studio";
import { useChat } from "../store/chat";
import { exportSourceZip } from "../lib/zip";
import { backupToTelegram, telegramReady } from "../lib/backup";
import { slugify, timeAgo } from "../lib/util";
import { saveFile } from "../lib/runtime";
import { handleTelegramDbCommand } from "../lib/telegramDbCommand";
import { readTelegramDbConfig } from "../lib/telegramDb";
import { detectProvider, isSharedOrigin, type AiProvider } from "../db/db";
import { PreviewPane } from "./PreviewPane";
import { Icon } from "./Icon";

const ACCEPT = "image/*,video/*,application/pdf,.svg,.html,.htm,.css,.js,.zip,.txt,.md,.json";

export function EasyView() {
  const stage = useEasy((s) => s.stage);
  return (
    <main className="easy" aria-live="polite">
      {stage === "start" && <StartScreen />}
      {stage === "working" && <WorkingScreen />}
      {stage === "result" && <ResultScreen />}
    </main>
  );
}

/* ── Conectar la IA gratuita (una sola vez) ─────────────────────── */
const PROVIDER_NAMES: Record<AiProvider, string> = { gemini: "Google Gemini (gratis)", openrouter: "OpenRouter (gratis)", anthropic: "Anthropic Claude (de pago)" };

function AiKeyCard({ onSaved, compact }: { onSaved?: () => void; compact?: boolean }) {
  const updateSettings = useStudio((s) => s.updateSettings);
  const toast = useStudio((s) => s.toast);
  const [key, setKey] = useState("");
  const save = async () => {
    const provider = detectProvider(key);
    if (!provider) {
      toast("Esa clave no parece de Google (empieza por «AIza» o «AQ»). Cópiala completa desde aistudio.google.com.", "error");
      return;
    }
    const field = provider === "gemini" ? "geminiApiKey" : provider === "openrouter" ? "openrouterApiKey" : "anthropicApiKey";
    await updateSettings({ aiProvider: provider, [field]: key.trim() });
    toast(`IA conectada: ${PROVIDER_NAMES[provider]}`, "success");
    onSaved?.();
  };
  return (
    <div className={`easy-card key-card${compact ? " compact" : ""}`}>
      <div className="easy-card-head">
        <Icon name="sparkles" size={18} />
        <b>Conecta la IA gratis</b>
      </div>
      <p className="muted">
        Para clonar desde capturas, vídeos o documentos se usa la IA de Google (Gemini), <b>gratis</b>: solo necesitas tu cuenta de Google, sin
        tarjeta ni pagos. Se hace una sola vez.
      </p>
      <ol className="key-steps">
        <li>
          Entra en{" "}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer noopener">
            aistudio.google.com/apikey
          </a>{" "}
          con tu cuenta de Google.
        </li>
        <li>Pulsa «Create API key» (Crear clave de API). Es gratis.</li>
        <li>Copia la clave (empieza por «AIza…» o «AQ…») y pégala aquí:</li>
      </ol>
      <div className="easy-input-row">
        <input
          id="easy-api-key"
          className="input"
          type="password"
          autoComplete="off"
          placeholder="AIza… o AQ…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void save()}
          aria-label="Clave de la IA"
        />
        <button className="btn primary" onClick={() => void save()} disabled={!key.trim()}>
          Guardar
        </button>
      </div>
      <small className="muted">
        {isSharedOrigin()
          ? "Por seguridad, en este enlace la clave solo se recuerda mientras la pestaña esté abierta."
          : "La clave se guarda solo en este navegador."}{" "}
        El plan gratuito de Google permite muchos clones al día; si se agota, se renueva solo. También sirve una clave gratuita de OpenRouter
        («sk-or-…»).
      </small>
    </div>
  );
}

/* ── Pantalla de inicio ────────────────────────────────────────── */
function StartScreen() {
  const { cloneUrl, cloneFiles, openResult } = useEasy.getState();
  const projects = useStudio((s) => s.projects);
  const health = useStudio((s) => s.health);
  const ai = useStudio((s) => s.ai);
  const webImages = useStudio((s) => s.webImages);
  const showKeyCard = useStudio((s) => needsApiKey(s));
  const aiReady = useStudio((s) => aiAvailable(s));
  const aiProvider = useStudio((s) => s.settings.aiProvider);
  const precision = useEasy((s) => s.precision);
  const setPrecision = useEasy((s) => s.setPrecision);
  const [url, setUrl] = useState("");
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const startUrl = (value = url) => {
    if (normalizeUrl(value)) void cloneUrl(value);
    else useStudio.getState().toast("Escribe una dirección web, por ejemplo «ejemplo.com».", "error");
  };

  return (
    <div
      className={`easy-start${over ? " over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (e.dataTransfer.files.length) void cloneFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <header className="easy-hero">
        <h1>¿Qué quieres clonar?</h1>
        <p className="muted">Pega el enlace de una web o sube una captura, un vídeo o un archivo. La vista previa aparece sola.</p>
      </header>

      {!health && ai === "claude" && webImages === false && (
        <div className="notice warning easy-notice">
          Desde aquí la IA no puede ver imágenes (depende de la app o navegador donde abres la página). Puedes subir la captura igualmente
          y describir lo que se ve, o abrir este enlace en el navegador (Safari o Chrome) para clonarla directamente.
        </div>
      )}
      {!health && ai === "claude" && webImages !== false && (
        <div className="notice easy-notice">
          Estás en la versión web: las capturas y los vídeos se clonan con tu cuenta de claude.ai (la primera vez te pedirá permiso). Para
          clonar por enlace, haz una captura de la web y súbela, o usa la app en tu ordenador.
        </div>
      )}
      {!health && ai === "none" && (
        <div className="notice warning easy-notice">
          No encuentro el servidor local. Ábrelo con «npm run dev» en tu ordenador y recarga esta página.
        </div>
      )}

      <div className="easy-options">
        <section className="easy-card" aria-labelledby="clone-url-title">
          <div className="easy-card-head">
            <Icon name="globe" size={18} />
            <b id="clone-url-title">Clonar una web</b>
          </div>
          <div className="easy-input-row">
            <input
              id="easy-url"
              className="input big"
              type="url"
              inputMode="url"
              placeholder="ejemplo.com"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && startUrl()}
              onPaste={(e) => {
                const text = e.clipboardData.getData("text");
                if (normalizeUrl(text)) {
                  e.preventDefault();
                  setUrl(text.trim());
                  startUrl(text);
                }
              }}
              aria-label="Dirección de la web"
            />
            <button className="btn primary big" onClick={() => startUrl()} disabled={!url.trim()}>
              Clonar
            </button>
          </div>
          <small className="muted">Al pegar un enlace, el clonado empieza solo.</small>
        </section>

        <section className="easy-card" aria-labelledby="clone-file-title">
          <div className="easy-card-head">
            <Icon name="image" size={18} />
            <b id="clone-file-title">Clonar desde un archivo</b>
          </div>
          <button className="easy-drop" onClick={() => fileRef.current?.click()}>
            <Icon name="upload" size={26} />
            <span>
              <b>Sube o arrastra aquí</b>
              <br />
              <span className="muted">Captura, vídeo, PDF, SVG, HTML o ZIP</span>
            </span>
          </button>
          <input
            ref={fileRef}
            type="file"
            hidden
            multiple
            accept={ACCEPT}
            onChange={(e) => {
              if (e.target.files?.length) void cloneFiles(Array.from(e.target.files));
              e.target.value = "";
            }}
          />
          <div className="precision">
            <span className="small muted" id="precision-label">
              Precisión con capturas y vídeos:
            </span>
            <div className="seg" role="group" aria-labelledby="precision-label">
              <button
                className={precision === "exact" ? "active" : ""}
                aria-pressed={precision === "exact"}
                onClick={() => setPrecision("exact")}
                title="La copia más fiel posible. Tarda de 3 a 7 minutos."
              >
                Máxima
              </button>
              <button
                className={precision === "fast" ? "active" : ""}
                aria-pressed={precision === "fast"}
                onClick={() => setPrecision("fast")}
                title="Resultado en 1 o 2 minutos, algo menos detallado."
              >
                Rápida
              </button>
            </div>
          </div>
          <small className="muted">
            {precision === "exact" ? "Máxima: la copia más fiel (usa las imágenes reales de tu captura y compara el resultado con ella hasta dos veces para corregir diferencias), tarda de 3 a 6 minutos." : "Rápida: 1 o 2 minutos, algo menos detallada."} Los HTML y
            ZIP se abren tal cual.
          </small>
        </section>
      </div>

      {showKeyCard ? (
        <AiKeyCard compact />
      ) : aiReady ? (
        <div className="ai-status card">
          <span className="ok">
            <Icon name="check" /> IA conectada: {PROVIDER_NAMES[aiProvider]}
          </span>
          <button className="btn sm" onClick={() => useStudio.getState().setSettingsOpen(true)} title="Cambiar la clave de la IA">
            <Icon name="settings" size={12} /> Cambiar clave
          </button>
        </div>
      ) : null}
      <p className="muted small" style={{ textAlign: "center", margin: 0 }}>
        ¿No sabes qué hace un botón? Pulsa <b>?</b> arriba a la derecha.
      </p>

      {projects.length > 0 && (
        <section className="easy-recent" aria-labelledby="recent-title">
          <h2 id="recent-title">Tus clones</h2>
          <div className="recent-grid">
            {projects.slice(0, 12).map((p) => (
              <button key={p.id} className="recent" onClick={() => void openResult(p.id)}>
                <Icon name={p.origin.type === "url" ? "globe" : p.origin.type === "reference" ? "image" : "folder"} size={18} />
                <span className="recent-text">
                  <span className="recent-name">{p.name}</span>
                  <span className="muted small">{timeAgo(p.updatedAt)}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
      {over && <div className="drop-overlay">Suelta el archivo para clonarlo</div>}
    </div>
  );
}

/** Segundos transcurridos mientras `active` sea true */
function useElapsed(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    setSeconds(0);
    if (!active) return;
    const start = Date.now();
    const id = setInterval(() => setSeconds(Math.round((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [active]);
  return seconds;
}

function formatElapsed(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/* ── Pantalla de progreso ──────────────────────────────────────── */
function WorkingScreen() {
  const job = useEasy((s) => s.job);
  const { cancel, retry, goHome, cloneFromDescription } = useEasy.getState();
  const [description, setDescription] = useState("");
  const streamText = useChat((s) => s.streamText);
  const elapsed = useElapsed(Boolean(job && !job.error));
  if (!job) return null;
  const filesInProgress = job.usesAi ? [...new Set([...streamText.matchAll(/<file\s+path="([^"]+)"/g)].map((m) => m[1]))] : [];
  const prose = job.usesAi && streamText ? parseFileBlocks(streamText).prose : "";

  return (
    <div className="easy-working">
      <div className="easy-card working-card">
        <h1>{job.needsDescription ? "Falta un paso" : job.error ? "No se pudo completar" : job.title}</h1>
        <ol className="steps">
          {job.steps.map((s, i) => (
            <li key={i} className={`step ${s.state}`}>
              <span className="step-icon" aria-hidden="true">
                {s.state === "done" ? <Icon name="check" size={14} /> : s.state === "active" ? <span className="spinner" /> : s.state === "error" ? <Icon name="x" size={14} /> : null}
              </span>
              {s.label}
            </li>
          ))}
        </ol>
        {!job.error && job.usesAi && (
          <div className="ai-live">
            {prose && <p className="muted">{prose.slice(0, 280)}</p>}
            {filesInProgress.length > 0 && (
              <div className="row wrap">
                {filesInProgress.map((f) => (
                  <span key={f} className="chip">
                    <Icon name="file" size={11} /> {f}
                  </span>
                ))}
              </div>
            )}
            <small className="muted">
              Tiempo: {formatElapsed(elapsed)} · {useEasy.getState().precision === "exact" ? "con precisión máxima suele tardar de 3 a 6 minutos" : "suele tardar 1 o 2 minutos"}. Puedes dejar esta pantalla abierta.
            </small>
          </div>
        )}
        {job.error && <div className={`notice ${job.needsDescription ? "warning" : "danger"}`}>{job.error}</div>}
        {job.needsKey && <AiKeyCard onSaved={() => void retry()} />}
        {job.needsDescription && (
          <div className="describe-box">
            <label className="field" htmlFor="easy-describe" style={{ marginBottom: 0 }}>
              <span>¿Qué se ve en la captura?</span>
            </label>
            <textarea
              id="easy-describe"
              className="textarea"
              rows={4}
              placeholder="Ej.: una tienda online con menú arriba, un banner grande con una zapatilla, tres productos en tarjetas y un pie de página oscuro."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <button className="btn primary big" disabled={description.trim().length < 10} onClick={() => void cloneFromDescription(description)}>
              <Icon name="sparkles" /> Crear con mi descripción
            </button>
            <small className="muted">
              Consejo: abre este mismo enlace en el navegador (Safari o Chrome) o en claude.ai desde el ordenador; allí puede que la IA sí vea
              la captura directamente.
            </small>
          </div>
        )}
        <div className="row wrap working-actions">
          {job.error ? (
            <>
              <button className="btn" onClick={goHome}>
                Volver
              </button>
              {!job.needsKey && job.canRetry !== false && (
                <button className="btn primary" onClick={() => void retry()}>
                  <Icon name="refresh" /> Reintentar
                </button>
              )}
            </>
          ) : (
            <button className="btn" onClick={cancel}>
              Cancelar
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Resultado: vista previa + cambios por texto ───────────────── */
function ResultScreen() {
  const project = useStudio((s) => s.project);
  const versions = useStudio((s) => s.versions);
  const note = useEasy((s) => (project ? s.notes[project.id] : undefined));
  const [hiddenNote, setHiddenNote] = useState("");
  const { goHome, setMode } = useEasy.getState();
  const { toast, restoreVersion, setSettingsOpen } = useStudio.getState();
  const { streaming, messages } = useChat();
  const canUseAi = useStudio((s) => aiAvailable(s));
  const missingKey = useStudio((s) => needsApiKey(s));
  const canDownload = useStudio((s) => s.canDownload);
  const dbConnected = useStudio((s) => Boolean(s.project && readTelegramDbConfig(s.project.files)));
  const [change, setChange] = useState("");
  const [busy, setBusy] = useState<"" | "zip" | "tg">("");
  const [showKey, setShowKey] = useState(false);

  useEffect(() => setShowKey(false), [project?.id]);
  if (!project) return null;

  const last = messages.at(-1);
  const lastAi = last?.role === "assistant" ? last : undefined;
  // Solo se reintenta una petición de cambio escrita por el usuario (no el clon inicial con adjuntos)
  const prevUser = messages.at(-2);
  const lastUserPrompt = prevUser?.role === "user" && !prevUser.meta?.attachments?.length ? prevUser.content : "";
  const lastVersionIdx = lastAi?.meta?.versionId ? versions.findIndex((v) => v.id === lastAi.meta!.versionId) : -1;
  const undoTarget = lastVersionIdx >= 0 ? versions[lastVersionIdx + 1] : undefined;

  const applyChange = async () => {
    const text = change.trim();
    if (!text || streaming) return;
    // «Conecta este proyecto con la base de datos de Telegram…» no va a la IA: se conecta directamente
    if (await handleTelegramDbCommand(text)) {
      setChange("");
      return;
    }
    if (missingKey) {
      setShowKey(true);
      return;
    }
    if (!canUseAi) {
      toast("La IA no está disponible aquí. Usa la app en tu ordenador (npm run dev).", "error");
      return;
    }
    setChange("");
    void useChat.getState().send(text);
  };

  const download = async () => {
    setBusy("zip");
    try {
      await useStudio.getState().flush();
      const saved = await saveFile(await exportSourceZip(useStudio.getState().project!), `${slugify(project.name)}.zip`);
      if (saved) toast("Descarga lista", "success");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy("");
    }
  };

  const saveTelegram = async () => {
    if (!telegramReady()) {
      toast("Primero conecta tu bot de Telegram en Ajustes.", "info");
      setSettingsOpen(true);
      return;
    }
    setBusy("tg");
    try {
      await backupToTelegram("project", project.id);
      toast("Guardado en Telegram", "success");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="easy-result">
      <div className="result-bar">
        <button className="btn" onClick={goHome} aria-label="Nuevo clon" title="Volver al inicio para clonar otra cosa">
          <Icon name="plus" /> <span className="label">Nuevo clon</span>
        </button>
        <div className="result-title">
          <b>{project.name}</b>
          {project.origin.detail && <span className="muted small">{project.origin.detail}</span>}
        </div>
        <div className="result-actions">
          <button className="btn" aria-label="Descargar" onClick={() => void download()} disabled={busy === "zip" || !canDownload} title={canDownload ? "Descargar el código" : "Esta vista no permite descargar ficheros"}>
            {busy === "zip" ? <span className="spinner" /> : <Icon name="download" />} <span className="label">Descargar</span>
          </button>
          <button
            className={`btn${dbConnected ? " connected" : ""}`}
            aria-label="Base de datos"
            onClick={() => useStudio.getState().openTelegramDb()}
            title={dbConnected ? "Conectado: los formularios envían sus datos a tu Telegram" : "Recibir en Telegram lo que la gente envíe en los formularios"}
          >
            <Icon name="database" /> <span className="label">{dbConnected ? "Datos ✓" : "Datos"}</span>
          </button>
          <button className="btn" aria-label="Guardar en Telegram" onClick={() => void saveTelegram()} disabled={busy === "tg"} title="Guardar una copia en tu Telegram">
            {busy === "tg" ? <span className="spinner" /> : <Icon name="cloud" />} <span className="label">Telegram</span>
          </button>
          <button className="btn" aria-label="Ver código" onClick={() => setMode("advanced")} title="Abrir el editor de código">
            <Icon name="terminal" /> <span className="label">Ver código</span>
          </button>
        </div>
      </div>
      {note && hiddenNote !== note && (
        <div className="notice result-note">
          <span>{note}</span>
          <button className="btn sm icon ghost" aria-label="Cerrar aviso" title="Cerrar aviso" onClick={() => setHiddenNote(note)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
      <div className="result-preview">
        <PreviewPane simple />
      </div>
      <div className="change-box">
        {showKey && missingKey && <AiKeyCard compact onSaved={() => setShowKey(false)} />}
        {streaming && (
          <div className="row muted small">
            <span className="spinner" /> Aplicando tu cambio…
          </div>
        )}
        {!streaming && lastAi && (lastAi.meta?.changed?.length || lastAi.meta?.error) ? (
          <div className="row wrap small change-status">
            {lastAi.meta?.error ? (
              <span style={{ color: "var(--danger)" }}>{lastAi.meta.error}</span>
            ) : (
              <span className="muted">{parseFileBlocks(lastAi.content).prose.slice(0, 200) || "Cambio aplicado."}</span>
            )}
            {lastAi.meta?.error && !lastAi.meta?.changed?.length && lastUserPrompt && (
              <button className="btn sm primary" onClick={() => void useChat.getState().send(lastUserPrompt)}>
                <Icon name="refresh" size={12} /> Reintentar
              </button>
            )}
            {undoTarget && (
              <button className="btn sm" onClick={() => void restoreVersion(undoTarget.id)}>
                <Icon name="history" size={12} /> Deshacer
              </button>
            )}
          </div>
        ) : null}
        <div className="easy-input-row">
          <input
            id="easy-change"
            className="input big"
            placeholder="¿Quieres cambiar algo? Ej.: «pon el botón en verde» o «añade un formulario de contacto»"
            value={change}
            onChange={(e) => setChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void applyChange()}
            disabled={streaming}
            aria-label="Describe el cambio que quieres"
          />
          {streaming ? (
            <button className="btn danger big" aria-label="Detener" onClick={() => useChat.getState().stop()}>
              <Icon name="stop" /> <span className="label">Detener</span>
            </button>
          ) : (
            <button className="btn primary big" aria-label="Aplicar cambio" onClick={() => void applyChange()} disabled={!change.trim()}>
              <Icon name="send" /> <span className="label">Aplicar</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
