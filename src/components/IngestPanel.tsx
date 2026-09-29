import { useRef, useState } from "react";
import { useStudio } from "../store/studio";
import { useChat } from "../store/chat";
import { ingest } from "../lib/api";
import type { IngestReport } from "../db/db";
import type { AssetRef } from "../../shared/types";
import { formatBytes } from "../lib/util";
import { Icon } from "./Icon";
import { ServerNotice } from "./ServerNotice";

function Report({ r }: { r: IngestReport }) {
  const { toast, setTab } = useStudio.getState();
  const [assetKind, setAssetKind] = useState<AssetRef["kind"] | "all">("all");
  const errors = r.a11y.filter((i) => i.severity === "error").length;
  const warnings = r.a11y.filter((i) => i.severity === "warning").length;
  const assets = assetKind === "all" ? r.assets : r.assets.filter((a) => a.kind === assetKind);
  const kinds = [...new Set(r.assets.map((a) => a.kind))];

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => toast(`Copiado: ${text}`, "success"));
  };

  const fixA11y = () => {
    const list = r.a11y
      .filter((i) => i.severity !== "info")
      .slice(0, 40)
      .map((i) => `- [${i.rule}] ${i.message}${i.snippet ? ` → ${i.snippet}` : ""}`)
      .join("\n");
    setTab("chat");
    void useChat.getState().send(`Corrige estos problemas de accesibilidad detectados en el análisis, sin cambiar el diseño visual:\n${list}`);
  };

  return (
    <>
      <div className="card" style={{ marginTop: 12 }}>
        <div className="row">
          <Icon name="globe" />
          <div className="grow">
            <div style={{ fontWeight: 600 }}>{r.title || "(sin título)"}</div>
            <a className="small mono" href={r.finalUrl} target="_blank" rel="noreferrer noopener">
              {r.finalUrl}
            </a>
          </div>
        </div>
        {r.description && <p className="small muted" style={{ marginBottom: 0 }}>{r.description}</p>}
        <div className="small muted" style={{ marginTop: 6 }}>
          Analizado el {new Date(r.fetchedAt).toLocaleString("es")} · idioma: {r.lang || "no declarado"}
        </div>
      </div>

      {r.warnings.length > 0 && (
        <div className="notice warning" style={{ marginTop: 8 }}>
          {r.warnings.slice(0, 8).map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </div>
      )}

      <div className="section-title">Estructura DOM</div>
      <div className="stats">
        <div className="stat"><b>{r.dom.totalElements}</b><span>elementos</span></div>
        <div className="stat"><b>{r.dom.maxDepth}</b><span>profundidad</span></div>
        <div className="stat"><b>{r.dom.links}</b><span>enlaces</span></div>
        <div className="stat"><b>{r.dom.images}</b><span>imágenes/SVG</span></div>
        <div className="stat"><b>{r.dom.forms}/{r.dom.inputs}</b><span>forms/campos</span></div>
        <div className="stat"><b>{r.dom.scripts}</b><span>scripts</span></div>
      </div>
      {r.dom.landmarks.length > 0 && (
        <div className="row wrap" style={{ marginTop: 8 }}>
          {r.dom.landmarks.map((l) => (
            <span key={l.role} className="badge">
              {l.role} ×{l.count}
            </span>
          ))}
        </div>
      )}

      <details className="block" style={{ marginTop: 10 }}>
        <summary>
          Etiquetas más usadas <span className="muted small">{r.dom.tagFrequency.length}</span>
        </summary>
        <div className="row wrap">
          {r.dom.tagFrequency.map((t) => (
            <span key={t.tag} className="chip">
              &lt;{t.tag}&gt; {t.count}
            </span>
          ))}
        </div>
      </details>

      <details className="block">
        <summary>
          Jerarquía de encabezados <span className="muted small">{r.outline.length}</span>
        </summary>
        <div>
          {r.outline.length === 0 && <div className="muted small">Sin encabezados.</div>}
          {r.outline.map((o, i) => (
            <div key={i} className="outline-item" style={{ paddingLeft: (o.level - 1) * 12 }}>
              <span className="muted mono">h{o.level}</span> {o.text}
            </div>
          ))}
        </div>
      </details>

      <details className="block" open={errors > 0}>
        <summary>
          Auditoría de accesibilidad
          <span className="row">
            <span className="badge danger">{errors}</span>
            <span className="badge warning">{warnings}</span>
          </span>
        </summary>
        <div>
          {r.a11y.length === 0 ? (
            <div className="muted small">No se detectaron problemas automáticos.</div>
          ) : (
            <>
              <div className="list">
                {r.a11y.slice(0, 80).map((i, idx) => (
                  <div key={idx} className="list-item">
                    <span className={`badge ${i.severity === "error" ? "danger" : i.severity === "warning" ? "warning" : "info"}`}>{i.rule}</span>
                    <div className="grow">
                      {i.message}
                      {i.snippet && <div className="mono muted" style={{ fontSize: 11 }}>{i.snippet}</div>}
                    </div>
                  </div>
                ))}
              </div>
              <button className="btn sm primary" style={{ marginTop: 8 }} onClick={fixA11y}>
                <Icon name="sparkles" size={12} /> Corregir con el asistente
              </button>
            </>
          )}
        </div>
      </details>

      <div className="section-title">Estilos ({formatBytes(r.css.bytes)} · {r.css.rules} reglas)</div>
      {r.css.colors.length > 0 && (
        <div className="swatches">
          {r.css.colors.slice(0, 24).map((c) => (
            <button key={c.value} className="swatch" onClick={() => copy(c.value)} title={`${c.count} usos — clic para copiar`}>
              <i style={{ background: c.value }} />
              {c.value.length > 22 ? c.value.slice(0, 22) + "…" : c.value}
            </button>
          ))}
        </div>
      )}
      <details className="block" style={{ marginTop: 10 }}>
        <summary>
          Tipografía <span className="muted small">{r.css.fontFamilies.length}</span>
        </summary>
        <div className="list">
          {r.css.fontFamilies.map((f) => (
            <div key={f.value} className="list-item">
              <span className="grow mono">{f.value}</span>
              <span className="muted">×{f.count}</span>
            </div>
          ))}
          {r.css.fontSizes.length > 0 && (
            <div className="row wrap" style={{ marginTop: 6 }}>
              {r.css.fontSizes.map((s) => (
                <span key={s.value} className="chip">
                  {s.value}
                </span>
              ))}
            </div>
          )}
        </div>
      </details>
      <details className="block">
        <summary>
          Variables CSS <span className="muted small">{r.css.customProperties.length}</span>
        </summary>
        <div className="list">
          {r.css.customProperties.slice(0, 120).map((v) => (
            <div key={v.name} className="list-item mono">
              <span className="grow">{v.name}</span>
              <span className="muted">{v.value.slice(0, 40)}</span>
            </div>
          ))}
        </div>
      </details>
      <details className="block">
        <summary>
          Breakpoints y media queries <span className="muted small">{r.css.breakpoints.length}</span>
        </summary>
        <div>
          <div className="row wrap">
            {r.css.breakpoints.map((b) => (
              <span key={b} className="chip">
                {b}
              </span>
            ))}
          </div>
          <div className="list" style={{ marginTop: 6 }}>
            {r.css.mediaQueries.slice(0, 30).map((m) => (
              <div key={m} className="list-item mono">
                @media {m}
              </div>
            ))}
          </div>
        </div>
      </details>

      <details className="block">
        <summary>
          Assets públicos <span className="muted small">{r.assets.length}</span>
        </summary>
        <div>
          <div className="row wrap" style={{ marginBottom: 6 }}>
            {(["all", ...kinds] as const).map((k) => (
              <button key={k} className={`btn sm${assetKind === k ? " primary" : ""}`} onClick={() => setAssetKind(k)}>
                {k === "all" ? "todos" : k}
              </button>
            ))}
          </div>
          <div className="list">
            {assets.slice(0, 200).map((a) => (
              <div key={a.url} className="list-item">
                <span className="badge">{a.kind}</span>
                <a className="grow mono" style={{ fontSize: 11 }} href={a.url} target="_blank" rel="noreferrer noopener">
                  {a.url}
                </a>
              </div>
            ))}
          </div>
        </div>
      </details>

      {r.dependencies.length > 0 && (
        <>
          <div className="section-title">Librerías detectadas</div>
          <div className="row wrap">
            {r.dependencies.map((d) => (
              <span key={d.id} className={`badge ${d.included ? "success" : "warning"}`}>
                {d.name}
              </span>
            ))}
          </div>
        </>
      )}
    </>
  );
}

export function IngestPanel() {
  const project = useStudio((s) => s.project);
  const { createProject, applyChanges, toast } = useStudio.getState();
  const [url, setUrl] = useState("");
  const [keepScripts, setKeepScripts] = useState(false);
  const [inlineCss, setInlineCss] = useState(true);
  const [target, setTarget] = useState<"new" | "current">("new");
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const run = async () => {
    if (!url.trim()) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const result = await ingest({ url: url.trim(), keepScripts, inlineStylesheets: inlineCss }, controller.signal);
      const { files, ...report } = result;
      const name = result.title ? `Estudio: ${result.title.slice(0, 50)}` : `Estudio: ${new URL(result.finalUrl).hostname}`;
      if (target === "new" || !project) {
        await createProject({
          name,
          files,
          origin: { type: "url", detail: result.finalUrl },
          ingest: report,
          message: `Análisis de ${result.finalUrl}`,
          source: "ingest",
        });
      } else {
        const deleted = Object.keys(project.files).filter((p) => !(p in files));
        await applyChanges(files, deleted, `Análisis de ${result.finalUrl}`, "ingest");
        useStudio.getState().patchProject({ ingest: report, origin: { type: "url", detail: result.finalUrl } });
      }
      toast(`Página analizada: ${result.dom.totalElements} elementos, ${result.assets.length} assets`, "success");
    } catch (err) {
      if ((err as Error).name !== "AbortError") toast((err as Error).message, "error");
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  };

  return (
    <div className="tool-body">
      <ServerNotice feature="el análisis de URLs" />
      <div className="field">
        <span>URL pública a analizar</span>
        <div className="row">
          <input
            className="input"
            type="url"
            placeholder="https://ejemplo.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !loading && void run()}
          />
          {loading ? (
            <button className="btn danger" onClick={() => abortRef.current?.abort()}>
              <Icon name="stop" /> Cancelar
            </button>
          ) : (
            <button className="btn primary" onClick={run} disabled={!url.trim()}>
              <Icon name="globe" /> Analizar
            </button>
          )}
        </div>
      </div>
      <div className="row wrap small" style={{ gap: 14, marginBottom: 10 }}>
        <label className="check">
          <input type="checkbox" checked={inlineCss} onChange={(e) => setInlineCss(e.target.checked)} /> Extraer CSS externo
        </label>
        <label className="check">
          <input type="checkbox" checked={keepScripts} onChange={(e) => setKeepScripts(e.target.checked)} /> Conservar scripts
        </label>
      </div>
      <div className="seg" role="group" aria-label="Destino" style={{ marginBottom: 10 }}>
        <button className={target === "new" ? "active" : ""} onClick={() => setTarget("new")}>
          Nuevo proyecto
        </button>
        <button className={target === "current" ? "active" : ""} onClick={() => setTarget("current")}>
          Reemplazar proyecto actual
        </button>
      </div>
      <div className="notice">
        Se descarga el HTML y CSS públicos para generar una réplica estática de estudio (auditoría de diseño y accesibilidad). Los scripts
        se eliminan por defecto y la vista previa se ejecuta aislada. Analiza solo páginas que tengas derecho a estudiar y respeta los
        derechos de autor y términos de uso del sitio.
      </div>
      {loading && (
        <div className="row muted" style={{ marginTop: 12 }}>
          <span className="spinner" /> Descargando y analizando…
        </div>
      )}
      {project?.ingest ? <Report r={project.ingest} /> : !loading && <div className="empty">El proyecto actual no procede de un análisis de URL.</div>}
    </div>
  );
}
