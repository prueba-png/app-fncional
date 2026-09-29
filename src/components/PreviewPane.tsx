import { useEffect, useMemo, useRef, useState } from "react";
import { useStudio } from "../store/studio";
import { BRIDGE_FLAG, buildPreviewDocument, findEntry } from "../lib/bundle";
import { Icon } from "./Icon";

type Viewport = "desktop" | "tablet" | "mobile";
const WIDTHS: Record<Viewport, string> = { desktop: "100%", tablet: "820px", mobile: "390px" };

interface ConsoleEntry {
  id: number;
  level: string;
  text: string;
}

/**
 * Previsualización segura: el código se ejecuta en un iframe con `sandbox`
 * SIN `allow-same-origin`, por lo que corre en un origen opaco y no puede
 * acceder a IndexedDB, cookies, al DOM del editor ni al servidor local.
 */
const SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock";

export function PreviewPane() {
  const files = useStudio((s) => s.project?.files);
  const projectId = useStudio((s) => s.project?.id);
  const autoInject = useStudio((s) => s.project?.autoInjectDeps ?? true);
  const [page, setPage] = useState<string>("");
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [doc, setDoc] = useState("");
  const [nonce, setNonce] = useState(0);
  const [logs, setLogs] = useState<ConsoleEntry[]>([]);
  const [showConsole, setShowConsole] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const seq = useRef(0);

  const pages = useMemo(() => Object.keys(files ?? {}).filter((p) => /\.html?$/i.test(p)), [files]);

  useEffect(() => {
    setPage("");
    setLogs([]);
  }, [projectId]);

  const build = () => {
    if (!files) return;
    try {
      setDoc(buildPreviewDocument(files, { page: page || findEntry(files) || undefined, autoInjectDeps: autoInject }));
    } catch (err) {
      setDoc(`<pre style="color:#c00;padding:16px">Error al construir la vista previa: ${String((err as Error).message)}</pre>`);
    }
  };

  // Reconstrucción con debounce al editar
  useEffect(() => {
    if (!autoRefresh) return;
    const t = setTimeout(build, 350);
    return () => clearTimeout(t);
  }, [files, page, autoInject, autoRefresh]);

  useEffect(() => setLogs([]), [doc, nonce]);

  // Mensajes desde el sandbox (solo del iframe propio)
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow) return;
      const data = e.data as { flag?: string; type?: string; level?: string; args?: string[]; path?: string };
      if (!data || data.flag !== BRIDGE_FLAG) return;
      if (data.type === "console") {
        const text = (data.args ?? []).join(" ");
        setLogs((l) => [...l.slice(-299), { id: ++seq.current, level: data.level ?? "log", text }]);
        if (data.level === "error") setShowConsole(true);
      } else if (data.type === "navigate" && typeof data.path === "string" && pages.includes(data.path)) {
        setPage(data.path);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [pages]);

  const errors = logs.filter((l) => l.level === "error").length;

  return (
    <>
      <div className="preview-toolbar">
        <Icon name="eye" />
        {pages.length > 1 ? (
          <select className="select" style={{ width: 150, height: 26, padding: "0 6px" }} value={page || findEntry(files ?? {}) || ""} onChange={(e) => setPage(e.target.value)} aria-label="Página">
            {pages.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        ) : (
          <span className="muted small">Vista previa aislada</span>
        )}
        <div className="grow" />
        <div className="seg" role="group" aria-label="Tamaño de pantalla">
          {(["desktop", "tablet", "mobile"] as Viewport[]).map((v) => (
            <button key={v} className={viewport === v ? "active" : ""} onClick={() => setViewport(v)} title={v} aria-pressed={viewport === v}>
              <Icon name={v === "desktop" ? "monitor" : v === "tablet" ? "tablet" : "phone"} size={14} />
            </button>
          ))}
        </div>
        <label className="check small muted" title="Recargar automáticamente al editar">
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} /> auto
        </label>
        <button
          className="btn sm icon ghost"
          title="Recargar"
          aria-label="Recargar vista previa"
          onClick={() => {
            build();
            setNonce((n) => n + 1);
          }}
        >
          <Icon name="refresh" size={14} />
        </button>
        <button className={`btn sm ghost${showConsole ? " active" : ""}`} onClick={() => setShowConsole((s) => !s)} title="Consola">
          <Icon name="terminal" size={14} />
          {errors > 0 ? <span className="badge danger">{errors}</span> : logs.length > 0 ? <span className="badge">{logs.length}</span> : null}
        </button>
      </div>
      <div className="preview-stage">
        <iframe
          key={nonce}
          ref={frameRef}
          className="preview-frame"
          title="Vista previa del prototipo"
          sandbox={SANDBOX}
          referrerPolicy="no-referrer"
          srcDoc={doc}
          style={{ width: WIDTHS[viewport] }}
        />
      </div>
      {showConsole && (
        <div className="console" aria-label="Consola">
          <div className="console-head">
            <span>Consola ({logs.length})</span>
            <button className="btn sm ghost" onClick={() => setLogs([])}>
              Limpiar
            </button>
          </div>
          <div className="console-body">
            {logs.length === 0 ? (
              <div className="console-line muted">Sin mensajes.</div>
            ) : (
              logs.map((l) => (
                <div key={l.id} className={`console-line ${l.level}`}>
                  {l.text}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </>
  );
}
