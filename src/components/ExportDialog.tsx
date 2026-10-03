import { useMemo, useState } from "react";
import { useStudio } from "../store/studio";
import { buildStandaloneHtml } from "../lib/bundle";
import { saveFile } from "../lib/runtime";
import { slugify } from "../lib/util";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";

/**
 * Envuelve todo el proyecto en un solo archivo HTML (con CSS, JS e imágenes dentro)
 * para poder alojarlo en Netlify, GitHub Pages, etc. Permite copiarlo o descargarlo.
 */
export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useStudio((s) => s.project);
  const toast = useStudio((s) => s.toast);
  const [copied, setCopied] = useState(false);

  const html = useMemo(() => {
    if (!project || !open) return "";
    try {
      return buildStandaloneHtml(project.files);
    } catch (err) {
      return `<!-- Error al generar el HTML: ${(err as Error).message} -->`;
    }
  }, [project, open]);

  const sizeKb = Math.round((new Blob([html]).size / 1024) * 10) / 10;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(html);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast("Código copiado al portapapeles", "success");
    } catch {
      // Algunos navegadores bloquean el portapapeles: se selecciona el texto para copiar a mano
      const area = document.getElementById("export-code") as HTMLTextAreaElement | null;
      area?.focus();
      area?.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        toast("Código copiado", "success");
      } catch {
        toast("No se pudo copiar solo. Toca el código, selecciona todo y copia.", "info");
      }
    }
  };

  const download = async () => {
    const name = `${slugify(project?.name || "pagina")}.html`;
    const ok = await saveFile(new Blob([html], { type: "text/html" }), name);
    if (ok) toast("Archivo HTML descargado", "success");
  };

  return (
    <Dialog
      title="Código para publicar (un solo archivo)"
      open={open}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cerrar
          </button>
          <button className="btn" onClick={() => void download()}>
            <Icon name="download" /> Descargar .html
          </button>
          <button className="btn primary" onClick={() => void copy()}>
            <Icon name={copied ? "check" : "copy"} /> {copied ? "¡Copiado!" : "Copiar todo el código"}
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        Todo el proyecto (HTML, estilos, JavaScript e imágenes) va dentro de este único archivo. Cópialo o descárgalo y súbelo a
        Netlify, GitHub Pages o cualquier alojamiento: funciona sin nada más. <b>{sizeKb} KB</b>.
      </p>
      <ol className="key-steps" style={{ marginBottom: 10 }}>
        <li>Pulsa «Copiar todo el código» (o «Descargar .html»).</li>
        <li>
          En <a href="https://app.netlify.com/drop" target="_blank" rel="noreferrer noopener">app.netlify.com/drop</a> arrastra el archivo
          .html (o pégalo en un archivo <code>index.html</code>).
        </li>
        <li>Netlify te da un enlace público al instante.</li>
      </ol>
      <textarea
        id="export-code"
        className="textarea mono"
        readOnly
        value={html}
        onFocus={(e) => e.currentTarget.select()}
        style={{ width: "100%", minHeight: 220, fontSize: 12 }}
        aria-label="Código HTML completo del proyecto"
      />
    </Dialog>
  );
}
