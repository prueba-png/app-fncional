import { useEffect, useState } from "react";
import { useStudio, IS_DEMO } from "../store/studio";
import { exportSourceZip } from "../lib/zip";
import { backupToTelegram, telegramReady } from "../lib/backup";
import { slugify } from "../lib/util";
import { saveFile } from "../lib/runtime";
import { getTheme, setTheme, type Theme } from "../lib/theme";
import { Icon } from "./Icon";
import { useEasy } from "../store/easy";

export function TopBar() {
  const project = useStudio((s) => s.project);
  const health = useStudio((s) => s.health);
  const { renameProject, commit, toast, setSettingsOpen, setTab } = useStudio.getState();
  const mode = useEasy((s) => s.mode);
  const setMode = useEasy((s) => s.setMode);
  const canDownload = useStudio((s) => s.canDownload);
  const [name, setName] = useState(project?.name ?? "");
  const [busy, setBusy] = useState<"" | "zip" | "tg">("");
  const [theme, setThemeState] = useState<Theme>(getTheme());

  useEffect(() => setName(project?.name ?? ""), [project?.id, project?.name]);

  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setThemeState(next);
  };

  const logo = (
    <button className="logo" onClick={() => mode === "easy" && useEasy.getState().goHome()} aria-label="DevStudio Pro, ir al inicio">
      <span className="logo-mark">
        <Icon name="bolt" size={15} />
      </span>
      DevStudio <small>Pro</small>
    </button>
  );
  const modeToggle = (
    <div className="seg mode-toggle" role="group" aria-label="Modo de la aplicación">
      <button className={mode === "easy" ? "active" : ""} aria-pressed={mode === "easy"} onClick={() => setMode("easy")} title="Modo fácil: clonar y pedir cambios">
        Fácil
      </button>
      <button className={mode === "advanced" ? "active" : ""} aria-pressed={mode === "advanced"} onClick={() => setMode("advanced")} title="Modo avanzado: editor de código y herramientas">
        Avanzado
      </button>
    </div>
  );
  const settingsButton = (
    <>
      <button
        className="btn icon"
        onClick={toggleTheme}
        title={theme === "dark" ? "Cambiar a tema claro" : "Cambiar a tema oscuro"}
        aria-label={theme === "dark" ? "Cambiar a tema claro" : "Cambiar a tema oscuro"}
      >
        <Icon name={theme === "dark" ? "sun" : "moon"} />
      </button>
      <button className="btn icon help-btn" onClick={() => useStudio.getState().setHelpOpen(true)} title="Ayuda: qué hace cada botón" aria-label="Ayuda">
        ?
      </button>
      <button className="btn icon" onClick={() => setSettingsOpen(true)} title="Ajustes: clave de la IA, Telegram y más" aria-label="Ajustes">
        <Icon name="settings" />
      </button>
    </>
  );

  if (mode === "easy" || !project) {
    return (
      <header className="topbar">
        {logo}
        <div className="spacer" />
        {modeToggle}
        {settingsButton}
      </header>
    );
  }

  const exportZip = async () => {
    setBusy("zip");
    try {
      await useStudio.getState().flush();
      const saved = await saveFile(await exportSourceZip(useStudio.getState().project!), `${slugify(project.name)}.zip`);
      if (saved) toast("ZIP exportado", "success");
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
      {logo}
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
        disabled={busy === "zip" || !canDownload}
        title={canDownload ? "Descargar el código fuente como ZIP" : "Esta vista no permite descargar ficheros"}
      >
        {busy === "zip" ? <span className="spinner" /> : <Icon name="download" />} <span className="label">Exportar ZIP</span>
      </button>
      <button className="btn" onClick={backup} disabled={busy === "tg"} title="Respaldar este proyecto en tu chat de Telegram">
        {busy === "tg" ? <span className="spinner" /> : <Icon name="cloud" />} <span className="label">Sincronizar</span>
      </button>
      {modeToggle}
      {settingsButton}
    </header>
  );
}
