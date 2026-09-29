/**
 * Modo fácil: clonado automático a partir de una URL o de cualquier archivo
 * (captura, vídeo, PDF, SVG, HTML o ZIP), con pasos visibles y vista previa final.
 */
import { create } from "zustand";
import type { ChatAttachment, FileMap } from "../../shared/types";
import * as db from "../db/db";
import { ingest } from "../lib/api";
import { processReferenceFile } from "../lib/media";
import { countImages, MAX_IMAGES_PER_REQUEST, referencesToAttachments } from "../lib/references";
import { readZip } from "../lib/zip";
import { useChat } from "./chat";
import { useStudio } from "./studio";

export type Mode = "easy" | "advanced";
export type Stage = "start" | "working" | "result";
export type StepState = "pending" | "active" | "done" | "error";

export interface Step {
  label: string;
  state: StepState;
}

export interface Job {
  kind: "url" | "files";
  title: string;
  steps: Step[];
  /** Mensaje de error comprensible para el usuario */
  error?: string;
  /** Falta la clave de la IA: la pantalla pide la clave y permite reintentar */
  needsKey?: boolean;
  /** Aviso informativo sobre el resultado */
  note?: string;
  usesAi: boolean;
}

interface EasyState {
  mode: Mode;
  stage: Stage;
  job: Job | null;
  /** Notas por proyecto sobre cómo se clonó (se muestran en el resultado) */
  notes: Record<string, string>;
  setMode(mode: Mode): void;
  goHome(): void;
  openResult(projectId: string): Promise<void>;
  cloneUrl(url: string): Promise<void>;
  cloneFiles(files: File[]): Promise<void>;
  retry(): Promise<void>;
  cancel(): void;
}

const MODE_KEY = "devstudio:mode";
const VISUAL_RE = /\.(png|jpe?g|webp|gif|bmp|avif|svg|mp4|webm|mov|m4v|ogv|pdf)$/i;
const CODE_RE = /\.(html?|css|m?js|json|txt|md|xml|svg)$/i;
const DOC_RE = /\.(txt|md|markdown|csv|json|xml)$/i;
const MAX_DOC_CHARS = 60_000;

let abortController: AbortController | null = null;
let lastInput: { kind: "url"; url: string } | { kind: "files"; files: File[] } | null = null;

function readMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === "advanced" ? "advanced" : "easy";
  } catch {
    return "easy";
  }
}

export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withProtocol);
    return u.hostname.includes(".") || u.hostname === "localhost" ? u.toString() : null;
  } catch {
    return null;
  }
}

function isVisual(f: File) {
  return f.type.startsWith("image/") || f.type.startsWith("video/") || f.type === "application/pdf" || VISUAL_RE.test(f.name);
}

const CLONE_PROMPT = `Clona con la máxima fidelidad posible la interfaz que aparece en los archivos adjuntos.
- Reproduce la estructura, los colores, la tipografía, los espaciados y los componentes tal como se ven.
- Crea una página completa y funcional: index.html, styles.css y script.js.
- Debe verse bien en móvil, tablet y escritorio (diseño responsive).
- Usa textos iguales o equivalentes a los de la referencia.`;

export const useEasy = create<EasyState>((set, get) => {
  const setSteps = (update: (steps: Step[]) => Step[]) => {
    const job = get().job;
    if (job) set({ job: { ...job, steps: update(job.steps) } });
  };
  /** Marca como terminado todo lo anterior al paso `i` y activa el paso `i` */
  const advance = (i: number) =>
    setSteps((steps) => steps.map((s, idx) => ({ ...s, state: idx < i ? "done" : idx === i ? "active" : s.state === "error" ? "pending" : s.state })));
  const fail = (message: string, extra: Partial<Job> = {}) => {
    const job = get().job;
    if (!job) return;
    set({
      job: { ...job, ...extra, error: message, steps: job.steps.map((s) => (s.state === "active" ? { ...s, state: "error" } : s)) },
    });
  };
  const finish = (note?: string) => {
    const id = useStudio.getState().project?.id;
    const notes = { ...get().notes };
    if (id) {
      if (note) notes[id] = note;
      else delete notes[id];
    }
    setSteps((steps) => steps.map((s) => ({ ...s, state: "done" })));
    set({ stage: "result", notes });
  };

  const aiReady = () => {
    const { settings, health } = useStudio.getState();
    return Boolean(settings.anthropicApiKey || health?.hasEnvApiKey);
  };

  return {
    mode: readMode(),
    stage: "start",
    job: null,
    notes: {},

    setMode(mode) {
      try {
        localStorage.setItem(MODE_KEY, mode);
      } catch {
        /* sin almacenamiento */
      }
      set({ mode });
    },

    goHome() {
      if (get().job && !get().job?.error && get().stage === "working") return;
      set({ stage: "start", job: null });
    },

    async openResult(projectId) {
      await useStudio.getState().openProject(projectId);
      set({ stage: "result", job: null });
    },

    cancel() {
      abortController?.abort();
      if (useChat.getState().streaming) useChat.getState().stop();
      set({ stage: "start", job: null });
    },

    async retry() {
      const input = lastInput;
      if (!input) return;
      if (input.kind === "url") await get().cloneUrl(input.url);
      else await get().cloneFiles(input.files);
    },

    async cloneUrl(raw) {
      const url = normalizeUrl(raw);
      if (!url) {
        useStudio.getState().toast("Esa dirección no parece válida. Prueba algo como «ejemplo.com».", "error");
        return;
      }
      // Se envía tal cual la escribió el usuario: sin protocolo, el servidor prueba HTTPS y luego HTTP
      const typed = raw.trim();
      lastInput = { kind: "url", url: typed };
      abortController = new AbortController();
      const host = new URL(url).hostname;
      set({
        stage: "working",
        job: {
          kind: "url",
          title: `Clonando ${host}`,
          usesAi: false,
          steps: [
            { label: "Descargando la página", state: "active" },
            { label: "Copiando estilos, imágenes y estructura", state: "pending" },
            { label: "Preparando la vista previa", state: "pending" },
          ],
        },
      });

      try {
        let result = await ingest({ url: typed, keepScripts: false }, abortController.signal);
        advance(1);
        let note: string | undefined;
        if (result.looksClientRendered) {
          setSteps((steps) => [
            ...steps.slice(0, 2),
            { label: "La web se construye con JavaScript: clonándola con sus scripts", state: "active" },
            ...steps.slice(2),
          ]);
          result = await ingest({ url: result.finalUrl, keepScripts: true }, abortController.signal);
          note =
            "Esta web se genera con JavaScript, así que el clon conserva sus scripts. Algunas partes (inicio de sesión, datos en vivo) pueden no funcionar fuera de la web original.";
        }
        advance(result.looksClientRendered ? 3 : 2);
        const { files, ...report } = result;
        await useStudio.getState().createProject({
          name: result.title ? result.title.slice(0, 60) : host,
          files,
          origin: { type: "url", detail: result.finalUrl },
          ingest: report,
          message: `Clon de ${result.finalUrl}`,
          source: "ingest",
        });
        if (result.warnings.length && !note) note = "Algunos recursos no se pudieron descargar, por lo que el clon puede verse incompleto.";
        finish(note);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        fail(friendlyUrlError((err as Error).message));
      } finally {
        abortController = null;
      }
    },

    async cloneFiles(files) {
      if (!files.length) return;
      lastInput = { kind: "files", files };
      const studio = useStudio.getState();
      const zips = files.filter((f) => /\.zip$/i.test(f.name) || f.type === "application/zip");
      const htmls = files.filter((f) => /\.html?$/i.test(f.name));
      const visuals = files.filter((f) => !zips.includes(f) && isVisual(f));
      const docs = files.filter((f) => !zips.includes(f) && !visuals.includes(f) && DOC_RE.test(f.name));
      const unsupported = files.filter((f) => !zips.includes(f) && !visuals.includes(f) && !docs.includes(f) && !CODE_RE.test(f.name));
      const title = files.length === 1 ? files[0].name : `${files.length} archivos`;

      if (unsupported.length) {
        set({ stage: "working", job: { kind: "files", title, usesAi: false, steps: [{ label: "Leyendo tus archivos", state: "active" }] } });
        fail(
          `No sé leer ${unsupported.map((f) => `«${f.name}»`).join(", ")}. Sube capturas (PNG, JPG), vídeos (MP4, WEBM), PDF, SVG, páginas HTML o un ZIP.`,
        );
        return;
      }

      // 1) ZIP: se importa tal cual, sin IA
      if (zips.length) {
        set({
          stage: "working",
          job: { kind: "files", title, usesAi: false, steps: [{ label: "Abriendo el ZIP", state: "active" }, { label: "Preparando la vista previa", state: "pending" }] },
        });
        try {
          const { bundles } = await readZip(zips[0], zips[0].name.replace(/\.zip$/i, ""));
          advance(1);
          await studio.importBundles(bundles, "import");
          finish();
        } catch (err) {
          fail(`No se pudo abrir el ZIP: ${(err as Error).message}`);
        }
        return;
      }

      // 2) Página HTML (con sus CSS/JS): se abre directamente, sin IA
      if (htmls.length && !visuals.length) {
        set({
          stage: "working",
          job: { kind: "files", title, usesAi: false, steps: [{ label: "Leyendo tus archivos", state: "active" }, { label: "Preparando la vista previa", state: "pending" }] },
        });
        try {
          const map: FileMap = {};
          for (const f of files) map[f.name] = await f.text();
          if (!("index.html" in map) && htmls.length === 1) {
            map["index.html"] = map[htmls[0].name];
            delete map[htmls[0].name];
          }
          advance(1);
          await studio.createProject({ name: htmls[0].name.replace(/\.html?$/i, ""), files: map, origin: { type: "import", detail: title } });
          finish();
        } catch (err) {
          fail(`No se pudieron leer los archivos: ${(err as Error).message}`);
        }
        return;
      }

      // 3) Capturas, vídeos, PDF, SVG o documentos: la IA reconstruye la interfaz
      set({
        stage: "working",
        job: {
          kind: "files",
          title,
          usesAi: true,
          steps: [
            { label: "Leyendo tus archivos", state: "active" },
            { label: "La IA está estudiando el diseño", state: "pending" },
            { label: "Construyendo la página", state: "pending" },
            { label: "Preparando la vista previa", state: "pending" },
          ],
        },
      });
      if (!studio.health) {
        fail("Para clonar desde imágenes o vídeos hace falta el servidor local. Ábrelo con «npm run dev» y vuelve a intentarlo.");
        return;
      }
      if (!aiReady()) {
        fail("Para clonar desde imágenes, vídeos o documentos necesitas conectar la IA (solo una vez).", { needsKey: true });
        return;
      }

      try {
        const project = await studio.createProject({
          name: `Clon de ${visuals[0]?.name ?? docs[0]?.name ?? "archivo"}`.replace(/\.[a-z0-9]+$/i, "").slice(0, 60),
          files: { "index.html": "", "styles.css": "", "script.js": "" },
          origin: { type: "reference", detail: files.map((f) => f.name).join(", ") },
        });
        const refs: db.VisualReference[] = [];
        for (const f of visuals) {
          const ref = await processReferenceFile(f, project.id, { videoFrames: 6 });
          await db.saveReference(ref);
          refs.push(ref);
        }
        const { attachments, labels } = referencesToAttachments(refs);
        const extra: ChatAttachment[] = [];
        for (const f of [...docs, ...htmls]) {
          extra.push({ type: "text", text: (await f.text()).slice(0, MAX_DOC_CHARS), label: f.name });
          labels.push(f.name);
        }
        const all = [...attachments, ...extra];
        if (countImages(all) > MAX_IMAGES_PER_REQUEST) {
          fail(`Son demasiadas imágenes a la vez (${countImages(all)}). Sube como máximo ${MAX_IMAGES_PER_REQUEST} capturas o fotogramas.`);
          return;
        }

        advance(1);
        const unsubscribe = useChat.subscribe((s) => {
          if (s.streamText.includes("<file")) advance(2);
        });
        try {
          await useChat.getState().send(CLONE_PROMPT, { attachments: all, attachmentLabels: labels, mode: "generate-from-reference" });
        } finally {
          unsubscribe();
        }
        if (get().stage !== "working") return; // cancelado

        const last = useChat.getState().messages.at(-1);
        const current = useStudio.getState().project;
        const built = current && Object.values(current.files).some((c) => c.trim().length > 0);
        if (last?.role === "assistant" && last.meta?.error && !built) {
          fail(friendlyAiError(last.meta.error));
          return;
        }
        if (!built) {
          fail("La IA no devolvió ninguna página. Prueba con una captura más clara o añade más detalles.");
          return;
        }
        advance(3);
        finish(last?.meta?.error ? "La IA avisó de un problema y el resultado puede estar incompleto. Puedes pedirle que lo termine." : undefined);
      } catch (err) {
        fail(friendlyAiError((err as Error).message));
      }
    },
  };
});

function friendlyUrlError(message: string): string {
  if (/servidor local/i.test(message)) return "No se puede clonar sin el servidor local. Ábrelo con «npm run dev» y vuelve a intentarlo.";
  if (/resolver el dominio/i.test(message)) return "No encuentro esa web. Revisa que la dirección esté bien escrita.";
  if (/red privada|local bloqueado/i.test(message)) return "Esa dirección apunta a tu red local y está bloqueada por seguridad.";
  if (/Tiempo de espera/i.test(message)) return "La web tardó demasiado en responder. Inténtalo de nuevo en un momento.";
  if (/límite/i.test(message)) return "La página es demasiado grande para clonarla.";
  return `No se pudo clonar la web: ${message}`;
}

function friendlyAiError(message: string): string {
  if (/clave de API no válida/i.test(message)) return "La clave de la IA no es válida. Revísala en Ajustes.";
  if (/Límite de peticiones/i.test(message)) return "La IA está ocupada. Espera unos segundos y vuelve a intentarlo.";
  if (/detenida por el usuario/i.test(message)) return "Has detenido el clonado.";
  return message;
}
