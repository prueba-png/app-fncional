import { useStudio } from "../store/studio";
import { TEMPLATES } from "../lib/templates";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";

export function NewProjectDialog() {
  const open = useStudio((s) => s.newProjectOpen);
  const { setNewProjectOpen, createProject, setTab } = useStudio.getState();
  const close = () => setNewProjectOpen(false);

  return (
    <Dialog title="Nuevo proyecto" open={open} onClose={close}>
      <div className="section-title" style={{ marginTop: 0 }}>
        Desde una plantilla
      </div>
      <div className="template-grid">
        {TEMPLATES.map((t) => (
          <button
            key={t.id}
            className="template"
            onClick={async () => {
              await createProject({ name: t.name === "En blanco" ? "Nuevo proyecto" : t.name, files: { ...t.files }, origin: { type: "template", detail: t.id } });
              setTab("chat");
              close();
            }}
          >
            <b>
              <Icon name="file" /> {t.name}
            </b>
            <span>{t.description}</span>
          </button>
        ))}
      </div>
      <div className="section-title">Desde una fuente</div>
      <div className="template-grid">
        <button
          className="template"
          onClick={() => {
            setTab("ingest");
            close();
          }}
        >
          <b>
            <Icon name="globe" /> Analizar URL
          </b>
          <span>Replica la estructura DOM y el CSS de una página pública para estudiarla.</span>
        </button>
        <button
          className="template"
          onClick={async () => {
            await createProject({ name: "Desde referencia visual", files: { "index.html": "", "styles.css": "", "script.js": "" }, origin: { type: "reference" } });
            setTab("references");
            close();
          }}
        >
          <b>
            <Icon name="image" /> Referencia visual
          </b>
          <span>Genera la interfaz a partir de capturas, vídeos o ficheros de diseño.</span>
        </button>
        <button
          className="template"
          onClick={() => {
            setTab("telegram");
            close();
          }}
        >
          <b>
            <Icon name="cloud" /> Restaurar de Telegram
          </b>
          <span>Recupera proyectos desde tus copias de seguridad.</span>
        </button>
      </div>
    </Dialog>
  );
}
