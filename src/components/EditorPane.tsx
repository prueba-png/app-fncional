import { useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import { useStudio } from "../store/studio";
import { formatBytes, languageOf } from "../lib/util";
import { Icon } from "./Icon";

function extensionsFor(path: string) {
  const base = [EditorView.lineWrapping];
  switch (languageOf(path)) {
    case "html":
      return [...base, html({ autoCloseTags: true })];
    case "css":
      return [...base, css()];
    case "javascript":
      return [...base, javascript({ jsx: /\.(jsx|tsx)$/.test(path), typescript: /\.tsx?$/.test(path) })];
    case "json":
      return [...base, json()];
    case "markdown":
      return [...base, markdown()];
    default:
      return base;
  }
}

export function EditorPane() {
  const project = useStudio((s) => s.project);
  const { setActiveFile, updateFile, addFile, renameFile, deleteFile, ask } = useStudio.getState();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");

  const active = project?.activeFile ?? "";
  const content = project?.files[active];
  const extensions = useMemo(() => extensionsFor(active), [active]);

  if (!project) return null;
  const paths = Object.keys(project.files).sort((a, b) => {
    const order = (p: string) => (p === "index.html" ? 0 : /\.html?$/.test(p) ? 1 : /\.css$/.test(p) ? 2 : /\.m?js$/.test(p) ? 3 : 4);
    return order(a) - order(b) || a.localeCompare(b);
  });

  const commitRename = (from: string) => {
    if (draft.trim() && draft.trim() !== from) renameFile(from, draft);
    setRenaming(null);
  };

  return (
    <>
      <div className="file-tabs" role="tablist" aria-label="Ficheros del proyecto">
        {paths.map((p) =>
          renaming === p ? (
            <input
              key={p}
              className="input file-tab-input"
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => commitRename(p)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename(p);
                if (e.key === "Escape") setRenaming(null);
              }}
            />
          ) : (
            <button
              key={p}
              role="tab"
              aria-selected={p === active}
              className={`file-tab${p === active ? " active" : ""}`}
              onClick={() => setActiveFile(p)}
              onDoubleClick={() => {
                setDraft(p);
                setRenaming(p);
              }}
              title="Doble clic para renombrar"
            >
              <Icon name="file" size={13} />
              {p}
              <span
                className="close"
                role="button"
                aria-label={`Eliminar ${p}`}
                onClick={async (e) => {
                  e.stopPropagation();
                  const ok = await ask({
                    title: `Eliminar ${p}`,
                    message: "Podrás recuperarlo desde el historial si estaba incluido en alguna versión.",
                    confirmLabel: "Eliminar",
                    danger: true,
                  });
                  if (ok !== null) deleteFile(p);
                }}
              >
                <Icon name="x" size={12} />
              </span>
            </button>
          ),
        )}
        {creating ? (
          <input
            className="input file-tab-input"
            autoFocus
            placeholder="nuevo.css"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (draft.trim()) addFile(draft);
              setCreating(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                setDraft("");
                setCreating(false);
              }
            }}
          />
        ) : (
          <button
            className="file-tab"
            onClick={() => {
              setDraft("");
              setCreating(true);
            }}
            title="Nuevo fichero"
            aria-label="Nuevo fichero"
          >
            <Icon name="plus" size={14} />
          </button>
        )}
      </div>
      <div className="editor-host">
        {content !== undefined ? (
          <CodeMirror
            key={`${project.id}:${active}`}
            value={content}
            height="100%"
            theme={oneDark}
            extensions={extensions}
            onChange={(v) => updateFile(active, v)}
            basicSetup={{ foldGutter: true, highlightActiveLine: true, bracketMatching: true, autocompletion: true }}
          />
        ) : (
          <div className="empty">Crea un fichero con el botón + para empezar.</div>
        )}
      </div>
      <div className="editor-status">
        <span>
          {active || "—"} · {languageOf(active)}
        </span>
        <span>
          {content !== undefined ? `${content.split("\n").length} líneas · ${formatBytes(new Blob([content]).size)}` : ""}
        </span>
      </div>
    </>
  );
}
