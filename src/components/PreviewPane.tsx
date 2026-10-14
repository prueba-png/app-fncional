import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStudio } from "../store/studio";
import { BRIDGE_FLAG, buildPreviewDocument, findEntry } from "../lib/bundle";
import { Icon } from "./Icon";

type Viewport = "desktop" | "tablet" | "mobile";
/** Ancho real (px CSS) de cada pantalla: la página se pinta a ese ancho y se reduce para que quepa entera */
const DEVICES: Record<Viewport, { width: number; label: string; icon: "monitor" | "tablet" | "phone" }> = {
  desktop: { width: 1280, label: "Ordenador", icon: "monitor" },
  tablet: { width: 820, label: "Tablet", icon: "tablet" },
  mobile: { width: 390, label: "Móvil", icon: "phone" },
};

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

/** `simple`: oculta los controles técnicos (consola, recarga automática) en el modo fácil. */
export function PreviewPane({ simple = false }: { simple?: boolean }) {
  const files = useStudio((s) => s.project?.files);
  const projectId = useStudio((s) => s.project?.id);
  const autoInject = useStudio((s) => s.project?.autoInjectDeps ?? true);
  const origin = useStudio((s) => s.project?.origin);
  const preferred = useStudio((s) => s.project?.viewport);
  const baseUrl = origin?.type === "url" && /^https?:\/\//i.test(origin.detail ?? "") ? origin.detail : undefined;
  const [page, setPage] = useState<string>("");
  const [viewport, setViewport] = useState<Viewport>(preferred ?? "desktop");
  const [full, setFull] = useState(false);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const stageRef = useRef<HTMLDivElement>(null);
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
  useEffect(() => setViewport(preferred ?? "desktop"), [projectId, preferred]);

  // Tamaño disponible para la vista previa (cambia al girar el móvil, abrir el teclado o pasar a pantalla completa)
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);

  const build = () => {
    if (!files) return;
    try {
      setDoc(buildPreviewDocument(files, { page: page || findEntry(files) || undefined, autoInjectDeps: autoInject, baseUrl }));
    } catch (err) {
      setDoc(`<pre style="color:#c00;padding:16px">Error al construir la vista previa: ${String((err as Error).message)}</pre>`);
    }
  };

  // Reconstrucción con debounce al editar
  useEffect(() => {
    if (!autoRefresh) return;
    const t = setTimeout(build, 350);
    return () => clearTimeout(t);
  }, [files, page, autoInject, autoRefresh, baseUrl]);

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
        if (data.level === "error" && !simple) setShowConsole(true);
      } else if (data.type === "navigate" && typeof data.path === "string" && pages.includes(data.path)) {
        setPage(data.path);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [pages, simple]);

  const errors = logs.filter((l) => l.level === "error").length;

  // Escala para que el ancho completo de la pantalla elegida quepa sin barras de desplazamiento laterales
  const pad = stage.w < 560 ? 0 : 12;
  const availW = Math.max(1, stage.w - pad * 2);
  const availH = Math.max(1, stage.h - pad * 2);
  const deviceW = viewport === "desktop" ? Math.max(DEVICES.desktop.width, availW) : DEVICES[viewport].width;
  const scale = Math.min(1, availW / deviceW);
  const zoom = Math.round(scale * 100);

  return (
    <div className={`preview-shell${full ? " full" : ""}`}>
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
          <span className="muted small">{simple ? "Vista previa" : "Vista previa aislada"}</span>
        )}
        <div className="grow" />
        {zoom < 100 && (
          <span className="zoom-label small muted" title="La página se muestra reducida para que se vea entera">
            {zoom}%
          </span>
        )}
        <div className="seg" role="group" aria-label="Tamaño de pantalla">
          {(Object.keys(DEVICES) as Viewport[]).map((v) => (
            <button
              key={v}
              className={viewport === v ? "active" : ""}
              onClick={() => setViewport(v)}
              title={`Ver como en ${DEVICES[v].label.toLowerCase()} (${DEVICES[v].width} px)`}
              aria-label={DEVICES[v].label}
              aria-pressed={viewport === v}
            >
              <Icon name={DEVICES[v].icon} size={14} />
            </button>
          ))}
        </div>
        {!simple && (
          <label className="check small muted" title="Recargar automáticamente al editar">
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} /> auto
          </label>
        )}
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
        <button
          className={`btn sm ${full ? "primary" : "icon ghost"}`}
          title={full ? "Salir de pantalla completa (Esc)" : "Ver en pantalla completa"}
          aria-label={full ? "Salir de pantalla completa" : "Pantalla completa"}
          onClick={() => setFull((f) => !f)}
        >
          <Icon name={full ? "shrink" : "expand"} size={14} />
          {full && <span>Salir</span>}
        </button>
        {!simple && (
          <button className={`btn sm ghost${showConsole ? " active" : ""}`} onClick={() => setShowConsole((s) => !s)} title="Consola">
            <Icon name="terminal" size={14} />
            {errors > 0 ? <span className="badge danger">{errors}</span> : logs.length > 0 ? <span className="badge">{logs.length}</span> : null}
          </button>
        )}
      </div>
      <div className="preview-stage" ref={stageRef} style={{ padding: pad }}>
        <div className="preview-device" style={{ width: Math.round(deviceW * scale), height: availH }}>
          <iframe
            key={nonce}
            ref={frameRef}
            className="preview-frame"
            title="Vista previa del prototipo"
            sandbox={SANDBOX}
            referrerPolicy="no-referrer"
            srcDoc={doc}
            style={{ width: deviceW, height: Math.ceil(availH / scale), transform: scale < 1 ? `scale(${scale})` : undefined }}
          />
        </div>
      </div>
      {showConsole && !simple && (
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
    </div>
  );
}
