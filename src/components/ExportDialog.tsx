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
  // Por encima de esto, copiar al portapapeles deja de ser fiable en varios navegadores (sobre todo en
  // móvil: Safari iOS puede fallar o cortar el texto en silencio con unos cientos de KB, sin avisar de
  // nada raro). Con un proyecto grande de verdad (un clon fiel con sus imágenes, varias páginas…) es
  // mejor avisar y llevar a "Descargar", que escribe el archivo directamente y no tiene ese límite.
  const TOO_BIG_TO_COPY_KB = 400;
  const tooBigToCopy = sizeKb > TOO_BIG_TO_COPY_KB;

  const copy = async () => {
    if (tooBigToCopy) {
      toast("Este código es grande para copiarlo de forma fiable (sobre todo en el móvil: puede cortarse sin avisar). Usa «Descargar .html» y arrástralo a Netlify.", "info");
      return;
    }
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
        const ok = document.execCommand("copy");
        if (!ok) throw new Error("execCommand devolvió false");
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        toast("Código copiado", "success");
      } catch {
        toast("No se pudo copiar solo. Usa «Descargar .html» en su lugar (más fiable con código grande), o toca el código, selecciona todo y copia a mano.", "info");
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
          <button className={tooBigToCopy ? "btn primary" : "btn"} onClick={() => void download()}>
            <Icon name="download" /> Descargar .html
          </button>
          <button className={tooBigToCopy ? "btn" : "btn primary"} onClick={() => void copy()} disabled={tooBigToCopy} title={tooBigToCopy ? "Código grande: usa «Descargar .html» en su lugar (más fiable)" : undefined}>
            <Icon name={copied ? "check" : "copy"} /> {copied ? "¡Copiado!" : "Copiar todo el código"}
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        Todo el proyecto (HTML, estilos, JavaScript e imágenes) va dentro de este único archivo. Cópialo o descárgalo y súbelo a
        Netlify, GitHub Pages o cualquier alojamiento: funciona sin nada más. <b>{sizeKb} KB</b>.
        {tooBigToCopy && (
          <>
            {" "}
            Es un archivo grande: copiarlo puede fallar o cortarse a medias en algunos navegadores (sobre todo en el móvil), así que
            aquí mejor usa <b>«Descargar .html»</b>.
          </>
        )}
      </p>
      <ol className="key-steps" style={{ marginBottom: 10 }}>
        <li>Pulsa «Descargar .html» (o «Copiar todo el código» si el archivo no es muy grande).</li>
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
