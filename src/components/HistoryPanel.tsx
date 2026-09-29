import { useMemo, useState } from "react";
import { structuredPatch } from "diff";
import { useStudio } from "../store/studio";
import type { Version } from "../db/db";
import type { FileMap } from "../../shared/types";
import { timeAgo } from "../lib/util";
import { Icon } from "./Icon";

const SOURCE_LABEL: Record<Version["source"], { label: string; cls: string }> = {
  create: { label: "creación", cls: "info" },
  manual: { label: "manual", cls: "" },
  ai: { label: "IA", cls: "accent" },
  ingest: { label: "análisis", cls: "info" },
  rollback: { label: "rollback", cls: "warning" },
  dependency: { label: "librerías", cls: "success" },
  restore: { label: "restaurado", cls: "success" },
};

interface FileDiff {
  path: string;
  status: "added" | "removed" | "modified";
  lines: Array<{ kind: "add" | "del" | "ctx" | "hunk"; text: string }>;
  adds: number;
  dels: number;
}

function computeDiff(from: FileMap, to: FileMap): FileDiff[] {
  const paths = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort();
  const out: FileDiff[] = [];
  for (const path of paths) {
    const a = from[path];
    const b = to[path];
    if (a === b) continue;
    const patch = structuredPatch(path, path, a ?? "", b ?? "", "", "", { context: 2 });
    const lines: FileDiff["lines"] = [];
    let adds = 0;
    let dels = 0;
    for (const h of patch.hunks) {
      lines.push({ kind: "hunk", text: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@` });
      for (const l of h.lines) {
        if (l.startsWith("\\")) continue;
        const kind = l[0] === "+" ? "add" : l[0] === "-" ? "del" : "ctx";
        if (kind === "add") adds++;
        if (kind === "del") dels++;
        if (lines.length < 1500) lines.push({ kind, text: l });
      }
    }
    out.push({ path, status: a === undefined ? "added" : b === undefined ? "removed" : "modified", lines, adds, dels });
  }
  return out;
}

export function HistoryPanel() {
  const versions = useStudio((s) => s.versions);
  const files = useStudio((s) => s.project?.files ?? {});
  const { restoreVersion, commit, toast } = useStudio.getState();
  const [selected, setSelected] = useState<string | null>(null);
  const [compare, setCompare] = useState<"previous" | "current">("previous");

  const selectedIdx = versions.findIndex((v) => v.id === selected);
  const selectedVersion = selectedIdx >= 0 ? versions[selectedIdx] : null;
  const diffs = useMemo(() => {
    if (!selectedVersion) return [];
    if (compare === "current") return computeDiff(selectedVersion.files, files);
    const prev = versions[selectedIdx + 1];
    return computeDiff(prev?.files ?? {}, selectedVersion.files);
  }, [selectedVersion, selectedIdx, versions, compare, files]);

  const dirty = versions[0] ? computeDiff(versions[0].files, files).length > 0 : true;

  return (
    <div className="tool-body">
      <div className="row" style={{ marginBottom: 10 }}>
        <div className="grow small muted">
          {versions.length} versiones locales {dirty ? "· hay cambios sin versionar" : "· todo versionado"}
        </div>
        <button
          className="btn sm primary"
          disabled={!dirty}
          onClick={async () => {
            const label = prompt("Descripción de la versión:", "Instantánea manual");
            if (label === null) return;
            const v = await commit(label.trim() || "Instantánea manual", "manual");
            toast(v ? "Versión guardada" : "Sin cambios", v ? "success" : "info");
          }}
        >
          <Icon name="save" size={12} /> Guardar
        </button>
      </div>
      {versions.length === 0 && <div className="empty">Aún no hay versiones.</div>}
      {versions.map((v, i) => {
        const src = SOURCE_LABEL[v.source];
        const isSel = v.id === selected;
        return (
          <div key={v.id} className={`version${isSel ? " selected" : ""}`}>
            <div className="row">
              <span className={`badge ${src.cls}`}>{src.label}</span>
              <span className="small muted" title={new Date(v.createdAt).toLocaleString("es")}>
                {timeAgo(v.createdAt)}
              </span>
              {i === 0 && <span className="badge success">última</span>}
              <div className="grow" />
              <button className="btn sm ghost" onClick={() => setSelected(isSel ? null : v.id)} aria-expanded={isSel}>
                {isSel ? "Ocultar" : "Diff"}
              </button>
              <button
                className="btn sm"
                onClick={() => confirm(`¿Restaurar «${v.message}»? El estado actual se guardará antes como versión.`) && void restoreVersion(v.id)}
              >
                <Icon name="history" size={12} /> Restaurar
              </button>
            </div>
            <div className="title" style={{ marginTop: 6 }}>
              {v.message}
            </div>
            <div className="small muted">{Object.keys(v.files).length} ficheros</div>
            {isSel && (
              <div style={{ marginTop: 8 }}>
                <div className="seg" role="group" aria-label="Comparar con" style={{ marginBottom: 8 }}>
                  <button className={compare === "previous" ? "active" : ""} onClick={() => setCompare("previous")}>
                    vs. versión anterior
                  </button>
                  <button className={compare === "current" ? "active" : ""} onClick={() => setCompare("current")}>
                    vs. estado actual
                  </button>
                </div>
                {diffs.length === 0 && <div className="muted small">Sin diferencias.</div>}
                {diffs.map((d) => (
                  <details key={d.path} className="block" open={diffs.length <= 3}>
                    <summary>
                      <span className="mono small">{d.path}</span>
                      <span className="row small">
                        {d.status !== "modified" && <span className={`badge ${d.status === "added" ? "success" : "danger"}`}>{d.status === "added" ? "nuevo" : "eliminado"}</span>}
                        <span style={{ color: "var(--success)" }}>+{d.adds}</span>
                        <span style={{ color: "var(--danger)" }}>−{d.dels}</span>
                      </span>
                    </summary>
                    <div>
                      <div className="diff">
                        {d.lines.map((l, j) => (
                          <div key={j} className={`diff-line ${l.kind}`}>
                            {l.text || " "}
                          </div>
                        ))}
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
