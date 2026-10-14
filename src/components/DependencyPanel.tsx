import { useMemo } from "react";
import { DEPENDENCIES, addDependenciesToHtml, detectDependencies } from "../../shared/dependencies";
import { useStudio } from "../store/studio";
import { findEntry } from "../lib/bundle";
import { Icon } from "./Icon";

export function DependencyPanel() {
  const project = useStudio((s) => s.project);
  const { setAutoInjectDeps, applyChanges, toast } = useStudio.getState();
  const detected = useMemo(() => (project ? detectDependencies(project.files) : []), [project?.files]);

  if (!project) return null;
  const entry = findEntry(project.files);
  const missing = detected.filter((d) => !d.included);

  const install = async (ids: string[]) => {
    if (!entry) {
      toast("El proyecto no tiene un fichero HTML donde añadir las librerías.", "error");
      return;
    }
    const html = addDependenciesToHtml(project.files[entry], ids, project.files);
    const names = ids.map((id) => detected.find((d) => d.id === id)?.name ?? DEPENDENCIES.find((d) => d.id === id)?.name ?? id);
    await applyChanges({ [entry]: html }, [], `Librerías añadidas: ${names.join(", ")}`, "dependency");
    toast(`Añadido a ${entry}: ${names.join(", ")}`, "success");
  };

  const detectedIds = new Set(detected.map((d) => d.id));

  return (
    <div className="tool-body">
      <label className="check card" style={{ marginBottom: 12 }}>
        <input type="checkbox" checked={project.autoInjectDeps} onChange={(e) => setAutoInjectDeps(e.target.checked)} />
        <div>
          <div style={{ fontWeight: 500 }}>Inyección automática en la vista previa</div>
          <div className="small muted">Carga desde CDN las librerías detectadas que falten, sin modificar tu código.</div>
        </div>
      </label>

      <div className="row">
        <div className="section-title grow">Detectadas en el código ({detected.length})</div>
        {missing.length > 1 && (
          <button className="btn sm primary" onClick={() => void install(missing.map((d) => d.id))}>
            Añadir todas
          </button>
        )}
      </div>
      {detected.length === 0 && <div className="empty">No se han detectado librerías conocidas.</div>}
      <div className="list">
        {detected.map((d) => (
          <div key={d.id} className="list-item">
            <Icon name="package" />
            <div className="grow">
              <div className="row">
                <b>{d.name}</b>
                {d.included ? <span className="badge success">incluida</span> : <span className="badge warning">falta</span>}
                {!d.included && <span className="badge">{Math.round(d.confidence * 100)}%</span>}
              </div>
              {d.evidence.length > 0 && <div className="small muted">Señales: {d.evidence.join(" · ")}</div>}
            </div>
            {!d.included && (
              <button className="btn sm" onClick={() => void install([d.id])} title={`Añadir ${d.name} a ${entry}`}>
                <Icon name="plus" size={12} /> Añadir
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="section-title">Catálogo</div>
      <div className="list">
        {DEPENDENCIES.filter((d) => !detectedIds.has(d.id)).map((d) => (
          <div key={d.id} className="list-item">
            <div className="grow">
              <div className="row">
                <b>{d.name}</b>
                <a className="small" href={d.homepage} target="_blank" rel="noreferrer noopener" aria-label={`Web de ${d.name}`}>
                  <Icon name="external" size={11} />
                </a>
              </div>
              <div className="small muted">{d.description}</div>
            </div>
            <button className="btn sm ghost" onClick={() => void install([d.id])}>
              <Icon name="plus" size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
