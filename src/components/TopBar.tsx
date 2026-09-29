import { useEffect, useState } from "react";
import { useStudio, IS_DEMO } from "../store/studio";
import { exportSourceZip } from "../lib/zip";
import { backupToTelegram, telegramReady } from "../lib/backup";
import { downloadBlob, slugify } from "../lib/util";
import { Icon } from "./Icon";

export function TopBar() {
  const project = useStudio((s) => s.project);
  const health = useStudio((s) => s.health);
  const { renameProject, commit, toast, setSettingsOpen, setTab } = useStudio.getState();
  const [name, setName] = useState(project?.name ?? "");
  const [busy, setBusy] = useState<"" | "zip" | "tg">("");

  useEffect(() => setName(project?.name ?? ""), [project?.id, project?.name]);

  if (!project) return <header className="topbar" />;

  const exportZip = async () => {
    setBusy("zip");
    try {
      await useStudio.getState().flush();
      downloadBlob(await exportSourceZip(useStudio.getState().project!), `${slugify(project.name)}.zip`);
      toast("ZIP exportado", "success");
    } catch (err) {
      toast(`Error al exportar: ${(err as Error).message}`, "error");
    } finally {
      setBusy("");
    }
  };

  const backup = async () => {
    if (!telegramReady()) {
      toast("Conecta tu bot de Telegram en Ajustes para sincronizar.", "info");
      setSettingsOpen(true);
      return;
    }
    setBusy("tg");
    try {
      await backupToTelegram("project", project.id);
      toast("Copia enviada a Telegram", "success");
      setTab("telegram");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy("");
    }
  };

  const snapshot = async () => {
    const v = await commit("Instantánea manual", "manual");
    toast(v ? "Versión guardada" : "Sin cambios desde la última versión", v ? "success" : "info");
  };

  return (
    <header className="topbar">
      <div className="logo">
        <div className="logo-mark">
          <Icon name="bolt" size={15} />
        </div>
        DevStudio <small>Pro</small>
      </div>
      <input
        className="project-name"
        value={name}
        aria-label="Nombre del proyecto"
        onChange={(e) => setName(e.target.value)}
        onBlur={() => (name.trim() ? void renameProject(project.id, name) : setName(project.name))}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      {IS_DEMO ? (
        <span className="badge warning" title="Versión web de demostración: el análisis de URLs, el asistente y Telegram necesitan el servidor local">
          demo web
        </span>
      ) : (
        <span className="badge" title={health ? "Servidor local conectado" : "Servidor local no disponible"}>
          <span className={`dot${health ? " ok" : ""}`} /> {health ? "local" : "sin servidor"}
        </span>
      )}
      <div className="spacer" />
      <button className="btn" onClick={snapshot} title="Guardar versión (Ctrl+S)">
        <Icon name="save" /> <span className="label">Guardar versión</span>
      </button>
      <button
        className="btn"
        onClick={exportZip}
        disabled={busy === "zip" || IS_DEMO}
        title={IS_DEMO ? "Las descargas están bloqueadas en la demo web" : "Descargar el código fuente como ZIP"}
      >
        {busy === "zip" ? <span className="spinner" /> : <Icon name="download" />} <span className="label">Exportar ZIP</span>
      </button>
      <button className="btn" onClick={backup} disabled={busy === "tg"} title="Respaldar este proyecto en tu chat de Telegram">
        {busy === "tg" ? <span className="spinner" /> : <Icon name="cloud" />} <span className="label">Sincronizar</span>
      </button>
      <button className="btn icon" onClick={() => setSettingsOpen(true)} title="Ajustes" aria-label="Ajustes">
        <Icon name="settings" />
      </button>
    </header>
  );
}
