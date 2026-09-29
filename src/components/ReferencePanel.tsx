import { useEffect, useRef, useState } from "react";
import type { ChatAttachment } from "../../shared/types";
import { useStudio } from "../store/studio";
import { useChat } from "../store/chat";
import * as db from "../db/db";
import type { VisualReference } from "../db/db";
import { processReferenceFile } from "../lib/media";
import { dataUrlParts, formatBytes } from "../lib/util";
import { Icon } from "./Icon";

const MAX_IMAGES_PER_REQUEST = 20;

function toAttachments(refs: VisualReference[]): { attachments: ChatAttachment[]; labels: string[] } {
  const attachments: ChatAttachment[] = [];
  const labels: string[] = [];
  for (const r of refs) {
    labels.push(r.name);
    if (r.kind === "pdf" && r.pdf) {
      attachments.push({ type: "pdf", data: dataUrlParts(r.pdf).data, label: r.name });
      continue;
    }
    if (r.kind === "svg" && r.svgText) attachments.push({ type: "text", text: r.svgText.slice(0, 60_000), label: `${r.name} (SVG)` });
    r.frames.forEach((f, i) => {
      const { mediaType, data } = dataUrlParts(f);
      attachments.push({
        type: "image",
        mediaType: mediaType as "image/jpeg" | "image/png",
        data,
        label: r.kind === "video" ? `${r.name} · fotograma ${i + 1}/${r.frames.length}` : r.name,
      });
    });
    if (r.palette.length) attachments.push({ type: "text", text: `Paleta dominante de ${r.name}: ${r.palette.join(", ")}` });
  }
  return { attachments, labels };
}

export function ReferencePanel() {
  const projectId = useStudio((s) => s.project?.id);
  const { toast, setTab } = useStudio.getState();
  const streaming = useChat((s) => s.streaming);
  const [refs, setRefs] = useState<VisualReference[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [over, setOver] = useState(false);
  const [processing, setProcessing] = useState<string>("");
  const [frames, setFrames] = useState(6);
  const [instructions, setInstructions] = useState("");
  const [target, setTarget] = useState<"current" | "new">("current");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!projectId) return;
    void db.listReferences(projectId).then((r) => {
      setRefs(r);
      setSelected(new Set(r.map((x) => x.id)));
    });
  }, [projectId]);

  const addFiles = async (list: FileList | File[]) => {
    if (!projectId) return;
    for (const file of Array.from(list)) {
      setProcessing(file.name);
      try {
        const ref = await processReferenceFile(file, projectId, {
          videoFrames: frames,
          onProgress: (p) => setProcessing(`${file.name} · ${Math.round(p * 100)}%`),
        });
        await db.saveReference(ref);
        setRefs((r) => [...r, ref]);
        setSelected((s) => new Set(s).add(ref.id));
      } catch (err) {
        toast((err as Error).message, "error");
      }
    }
    setProcessing("");
  };

  const remove = async (id: string) => {
    await db.deleteReference(id);
    setRefs((r) => r.filter((x) => x.id !== id));
    setSelected((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
  };

  const generate = async () => {
    const chosen = refs.filter((r) => selected.has(r.id));
    if (!chosen.length) return;
    const { attachments, labels } = toAttachments(chosen);
    const images = attachments.filter((a) => a.type === "image").length;
    if (images > MAX_IMAGES_PER_REQUEST) {
      toast(`Demasiadas imágenes (${images}); selecciona como máximo ${MAX_IMAGES_PER_REQUEST} fotogramas en total.`, "error");
      return;
    }
    if (target === "new") {
      const studio = useStudio.getState();
      await studio.createProject({
        name: `Desde referencia: ${chosen[0].name}`.slice(0, 60),
        files: { "index.html": "", "styles.css": "", "script.js": "" },
        origin: { type: "reference", detail: labels.join(", ") },
      });
      // Las referencias se copian al nuevo proyecto
      const newId = useStudio.getState().project!.id;
      for (const r of chosen) await db.saveReference({ ...r, id: `${r.id}_${newId}`, projectId: newId });
    }
    setTab("chat");
    const prompt =
      `Genera una interfaz equivalente a las referencias visuales adjuntas.` +
      (instructions.trim() ? `\n\nIndicaciones adicionales:\n${instructions.trim()}` : "");
    await useChat.getState().send(prompt, { attachments, attachmentLabels: labels, mode: "generate-from-reference" });
  };

  const selectedCount = refs.filter((r) => selected.has(r.id)).length;

  return (
    <div className="tool-body">
      <div
        className={`dropzone${over ? " over" : ""}`}
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void addFiles(e.dataTransfer.files);
        }}
      >
        <Icon name="upload" size={22} />
        <div style={{ marginTop: 6 }}>Arrastra capturas, vídeos, SVG o PDF de diseño</div>
        <div className="small">o haz clic para seleccionarlos · procesamiento 100 % local</div>
        <input
          ref={inputRef}
          type="file"
          hidden
          multiple
          accept="image/*,video/*,.svg,application/pdf"
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
      <div className="row small muted" style={{ marginTop: 8 }}>
        <label htmlFor="frames">Fotogramas por vídeo</label>
        <input id="frames" type="range" min={1} max={8} value={frames} onChange={(e) => setFrames(Number(e.target.value))} />
        <span>{frames}</span>
      </div>
      {processing && (
        <div className="row muted" style={{ marginTop: 8 }}>
          <span className="spinner" /> Procesando {processing}
        </div>
      )}

      {refs.length > 0 && (
        <>
          <div className="section-title">Referencias ({selectedCount}/{refs.length} seleccionadas)</div>
          <div className="ref-grid">
            {refs.map((r) => {
              const isSel = selected.has(r.id);
              return (
                <div key={r.id} className={`ref${isSel ? " selected" : ""}`}>
                  {r.kind === "pdf" ? (
                    <div className="pdf">
                      <Icon name="file" size={30} />
                    </div>
                  ) : (
                    <img src={r.frames[Math.floor(r.frames.length / 2)]} alt={`Referencia ${r.name}`} />
                  )}
                  <input
                    className="select-box"
                    type="checkbox"
                    checked={isSel}
                    aria-label={`Seleccionar ${r.name}`}
                    onChange={() =>
                      setSelected((s) => {
                        const n = new Set(s);
                        if (n.has(r.id)) n.delete(r.id);
                        else n.add(r.id);
                        return n;
                      })
                    }
                  />
                  <button className="btn sm icon remove" aria-label={`Eliminar ${r.name}`} onClick={() => void remove(r.id)}>
                    <Icon name="x" size={12} />
                  </button>
                  <div className="info">
                    <div className="name" title={r.name}>{r.name}</div>
                    <div className="muted">
                      {r.kind} · {formatBytes(r.size)}
                      {r.width ? ` · ${r.width}×${r.height}` : ""}
                      {r.kind === "video" ? ` · ${r.frames.length} fotogramas` : ""}
                    </div>
                    {r.kind === "video" && (
                      <div className="frames">
                        {r.frames.map((f, i) => (
                          <img key={i} src={f} alt={`Fotograma ${i + 1}`} />
                        ))}
                      </div>
                    )}
                    {r.palette.length > 0 && (
                      <div className="row" style={{ gap: 2, marginTop: 4 }}>
                        {r.palette.map((c) => (
                          <span key={c} title={c} style={{ width: 14, height: 14, borderRadius: 3, background: c, border: "1px solid #fff2" }} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="section-title">Generar componentes</div>
          <div className="field">
            <textarea
              className="textarea"
              placeholder="Indicaciones opcionales: framework CSS preferido, qué parte reproducir, comportamiento esperado…"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </div>
          <div className="seg" role="group" aria-label="Destino" style={{ marginBottom: 10 }}>
            <button className={target === "current" ? "active" : ""} onClick={() => setTarget("current")}>
              En el proyecto actual
            </button>
            <button className={target === "new" ? "active" : ""} onClick={() => setTarget("new")}>
              En un proyecto nuevo
            </button>
          </div>
          <button className="btn primary" style={{ width: "100%", justifyContent: "center" }} disabled={!selectedCount || streaming} onClick={() => void generate()}>
            <Icon name="sparkles" /> Generar interfaz desde {selectedCount} referencia(s)
          </button>
        </>
      )}
    </div>
  );
}
