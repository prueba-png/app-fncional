import { useEffect, useRef, useState } from "react";
import { useStudio } from "./store/studio";
import { useChat } from "./store/chat";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";
import { EditorPane } from "./components/EditorPane";
import { PreviewPane } from "./components/PreviewPane";
import { ToolPanel } from "./components/ToolPanel";
import { SettingsDialog } from "./components/SettingsDialog";
import { NewProjectDialog } from "./components/NewProjectDialog";
import { Toasts } from "./components/Toasts";
import { AskDialog } from "./components/AskDialog";
import { HelpDialog } from "./components/HelpDialog";
import { TelegramDbDialog } from "./components/TelegramDbDialog";
import { useAutoBackup } from "./hooks/useAutoBackup";
import { useEasy } from "./store/easy";
import { EasyView } from "./components/EasyView";

export function App() {
  const ready = useStudio((s) => s.ready);
  const projectId = useStudio((s) => s.project?.id);
  const mode = useEasy((s) => s.mode);
  const [split, setSplit] = useState(50);
  const [dragging, setDragging] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void useStudio.getState().init();
  }, []);

  useEffect(() => {
    if (projectId) void useChat.getState().load(projectId);
  }, [projectId]);

  // Ctrl/Cmd+S → instantánea manual
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void useStudio
          .getState()
          .commit("Instantánea manual", "manual")
          .then((v) => useStudio.getState().toast(v ? "Versión guardada" : "Sin cambios desde la última versión", v ? "success" : "info"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useAutoBackup();

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const rect = workspaceRef.current?.getBoundingClientRect();
      if (!rect) return;
      setSplit(Math.min(80, Math.max(20, ((e.clientX - rect.left) / rect.width) * 100)));
    };
    const up = () => setDragging(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [dragging]);

  if (!ready) {
    return (
      <div className="loading-screen">
        <div className="row">
          <span className="spinner" /> Cargando DevStudio Pro…
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar />
      {mode === "easy" ? (
        <EasyView />
      ) : (
        <div className="main">
        <Sidebar />
        <div className="workspace" ref={workspaceRef}>
          <div className="pane" style={{ width: `${split}%` }}>
            <EditorPane />
          </div>
          <div
            className={`splitter${dragging ? " dragging" : ""}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="Redimensionar editor y vista previa"
            tabIndex={0}
            onPointerDown={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") setSplit((s) => Math.max(20, s - 5));
              if (e.key === "ArrowRight") setSplit((s) => Math.min(80, s + 5));
            }}
          />
          <div className="pane" style={{ flex: 1, pointerEvents: dragging ? "none" : undefined }}>
            <PreviewPane />
          </div>
        </div>
          <ToolPanel />
        </div>
      )}
      <SettingsDialog />
      <NewProjectDialog />
      <AskDialog />
      <HelpDialog />
      <TelegramDbDialog />
      <Toasts />
    </div>
  );
}
