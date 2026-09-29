import { useEffect, useState } from "react";
import { useStudio } from "../store/studio";
import type { Settings } from "../db/db";
import { telegramTest } from "../lib/api";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";

const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (recomendado)" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (más rápido)" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1 (máxima capacidad)" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (económico)" },
];

export function SettingsDialog() {
  const open = useStudio((s) => s.settingsOpen);
  const settings = useStudio((s) => s.settings);
  const health = useStudio((s) => s.health);
  const { setSettingsOpen, updateSettings, toast } = useStudio.getState();
  const [draft, setDraft] = useState<Settings>(settings);
  const [showKey, setShowKey] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string>("");

  useEffect(() => {
    if (open) {
      setDraft(settings);
      setTestResult("");
    }
  }, [open, settings]);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const close = () => setSettingsOpen(false);

  const save = async () => {
    await updateSettings({
      ...draft,
      anthropicApiKey: draft.anthropicApiKey.trim(),
      telegramToken: draft.telegramToken.trim(),
      telegramChatId: draft.telegramChatId.trim(),
      autoBackupMinutes: Math.max(0, Math.round(draft.autoBackupMinutes)),
    });
    toast("Ajustes guardados", "success");
    close();
  };

  const test = async () => {
    setTesting(true);
    setTestResult("");
    try {
      const r = await telegramTest({ token: draft.telegramToken.trim(), chatId: draft.telegramChatId.trim() });
      setDraft((d) => ({ ...d, telegramChatTitle: r.chat.title }));
      setTestResult(`✓ Bot @${r.bot.username} conectado a «${r.chat.title}» (${r.chat.type}). Se envió un mensaje de prueba.`);
    } catch (err) {
      setTestResult(`✗ ${(err as Error).message}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <Dialog
      title="Ajustes"
      open={open}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancelar
          </button>
          <button className="btn primary" onClick={() => void save()}>
            <Icon name="check" /> Guardar
          </button>
        </>
      }
    >
      <div className="section-title" style={{ marginTop: 0 }}>
        Asistente de código (API de Anthropic)
      </div>
      <label className="field">
        <span>Clave de API</span>
        <div className="row">
          <input
            className="input mono"
            type={showKey ? "text" : "password"}
            autoComplete="off"
            placeholder={health?.hasEnvApiKey ? "Usando ANTHROPIC_API_KEY del servidor" : "sk-ant-…"}
            value={draft.anthropicApiKey}
            onChange={(e) => set("anthropicApiKey", e.target.value)}
          />
          <button className="btn icon" type="button" onClick={() => setShowKey((s) => !s)} aria-label={showKey ? "Ocultar clave" : "Mostrar clave"}>
            <Icon name="eye" />
          </button>
        </div>
        <small>Se guarda solo en este navegador (IndexedDB) y se envía únicamente a tu servidor local, que la usa para llamar a la API.</small>
      </label>
      <div className="row">
        <label className="field grow">
          <span>Modelo</span>
          <select className="select" value={draft.model} onChange={(e) => set("model", e.target.value)}>
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            {!MODELS.some((m) => m.id === draft.model) && <option value={draft.model}>{draft.model}</option>}
          </select>
        </label>
        <label className="field" style={{ width: 150 }}>
          <span>Esfuerzo</span>
          <select className="select" value={draft.effort} onChange={(e) => set("effort", e.target.value as Settings["effort"])} disabled={draft.model.startsWith("claude-haiku")}>
            <option value="low">Bajo</option>
            <option value="medium">Medio</option>
            <option value="high">Alto</option>
            <option value="xhigh">Muy alto</option>
            <option value="max">Máximo</option>
          </select>
        </label>
      </div>

      <div className="section-title">Almacenamiento descentralizado (Telegram)</div>
      <div className="notice" style={{ marginBottom: 12 }}>
        1. Crea un bot con <b>@BotFather</b> (<code>/newbot</code>) y copia su token. 2. Escribe cualquier mensaje a tu bot (o añádelo a un
        grupo/canal privado como administrador). 3. Obtén el Chat ID (p. ej. con <b>@userinfobot</b>; los canales empiezan por{" "}
        <code>-100</code>). Las copias se envían como documentos ZIP a ese chat.
      </div>
      <label className="field">
        <span>Token del bot</span>
        <div className="row">
          <input
            className="input mono"
            type={showToken ? "text" : "password"}
            autoComplete="off"
            placeholder="123456789:AA…"
            value={draft.telegramToken}
            onChange={(e) => set("telegramToken", e.target.value)}
          />
          <button className="btn icon" type="button" onClick={() => setShowToken((s) => !s)} aria-label={showToken ? "Ocultar token" : "Mostrar token"}>
            <Icon name="eye" />
          </button>
        </div>
      </label>
      <label className="field">
        <span>Chat ID</span>
        <input className="input mono" placeholder="123456789, -100… o @micanal" value={draft.telegramChatId} onChange={(e) => set("telegramChatId", e.target.value)} />
      </label>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="btn" onClick={() => void test()} disabled={testing || !draft.telegramToken || !draft.telegramChatId}>
          {testing ? <span className="spinner" /> : <Icon name="bolt" />} Probar conexión
        </button>
        {testResult && <span className="small" style={{ color: testResult.startsWith("✓") ? "var(--success)" : "var(--danger)" }}>{testResult}</span>}
      </div>
      <label className="field">
        <span>Copia automática del proyecto activo (minutos, 0 = desactivada)</span>
        <input
          className="input"
          type="number"
          min={0}
          max={1440}
          value={draft.autoBackupMinutes}
          onChange={(e) => set("autoBackupMinutes", Number(e.target.value) || 0)}
        />
        <small>Solo se envía si el proyecto ha cambiado desde su última copia.</small>
      </label>
    </Dialog>
  );
}
