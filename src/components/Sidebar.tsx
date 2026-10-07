import { useRef, useState } from "react";
import { useStudio } from "../store/studio";
import { readZip } from "../lib/zip";
import { timeAgo } from "../lib/util";
import { Icon } from "./Icon";

const ORIGIN_LABEL: Record<string, string> = {
  blank: "vacío",
  template: "plantilla",
  url: "URL",
  reference: "referencia",
  import: "importado",
  telegram: "Telegram",
};

export function Sidebar() {
  const projects = useStudio((s) => s.projects);
  const currentId = useStudio((s) => s.project?.id);
  const { openProject, renameProject, duplicateProject, deleteProject, setNewProjectOpen, importBundles, toast, ask } = useStudio.getState();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const onImport = async (file: File | undefined) => {
    if (!file) return;
    try {
      const { bundles, kind } = await readZip(file, file.name.replace(/\.zip$/i, ""));
      const n = await importBundles(bundles, "import");
      toast(kind === "bundle" ? `Restaurados ${n} proyecto(s)` : "Proyecto importado desde ZIP", "success");
    } catch (err) {
      toast(`No se pudo importar: ${(err as Error).message}`, "error");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <aside className="sidebar" aria-label="Proyectos">
      <div className="sidebar-header">
        <span className="section-title" style={{ margin: 0 }}>
          Proyectos ({projects.length})
        </span>
        <div className="row" style={{ gap: 2 }}>
          <button className="btn sm icon ghost" title="Importar ZIP" aria-label="Importar ZIP" onClick={() => fileRef.current?.click()}>
            <Icon name="upload" size={14} />
          </button>
          <button className="btn sm icon primary" title="Nuevo proyecto" aria-label="Nuevo proyecto" onClick={() => setNewProjectOpen(true)}>
            <Icon name="plus" size={14} />
          </button>
        </div>
        <input ref={fileRef} type="file" accept=".zip,application/zip" hidden onChange={(e) => void onImport(e.target.files?.[0])} />
      </div>
      <div className="project-list">
        {projects.map((p) => (
          <div
            key={p.id}
            className={`project-item${p.id === currentId ? " active" : ""}`}
            onClick={() => p.id !== currentId && void openProject(p.id)}
            onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && void openProject(p.id)}
            tabIndex={0}
            role="button"
            aria-current={p.id === currentId}
          >
            <Icon name={p.origin.type === "url" ? "globe" : p.origin.type === "reference" ? "image" : "folder"} size={15} />
            <div className="grow">
              {editing === p.id ? (
                <input
                  className="input"
                  autoFocus
                  value={draft}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => {
                    void renameProject(p.id, draft);
                    setEditing(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setEditing(null);
                  }}
                />
              ) : (
                <>
                  <div className="name">{p.name}</div>
                  <div className="meta">
                    {ORIGIN_LABEL[p.origin.type]} · {timeAgo(p.updatedAt)}
                  </div>
                </>
              )}
            </div>
            <div className="actions" onClick={(e) => e.stopPropagation()}>
              <button
                className="btn sm icon ghost"
                title="Renombrar"
                aria-label={`Renombrar ${p.name}`}
                onClick={() => {
                  setDraft(p.name);
                  setEditing(p.id);
                }}
              >
                <Icon name="edit" size={13} />
              </button>
              <button className="btn sm icon ghost" title="Duplicar" aria-label={`Duplicar ${p.name}`} onClick={() => void duplicateProject(p.id)}>
                <Icon name="copy" size={13} />
              </button>
              <button
                className="btn sm icon ghost danger"
                title="Eliminar"
                aria-label={`Eliminar ${p.name}`}
                onClick={async () => {
                  const ok = await ask({
                    title: `Eliminar «${p.name}»`,
                    message: "Se borrarán también su historial, su conversación y sus referencias. Esta acción no se puede deshacer.",
                    confirmLabel: "Eliminar proyecto",
                    danger: true,
                  });
                  if (ok !== null) await deleteProject(p.id);
                }}
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
