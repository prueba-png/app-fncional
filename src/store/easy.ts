/**
 * Modo fácil: clonado automático a partir de una URL o de cualquier archivo
 * (captura, vídeo, PDF, SVG, HTML o ZIP), con pasos visibles y vista previa final.
 */
import { create } from "zustand";
import type { ChatAttachment, FileMap } from "../../shared/types";
import * as db from "../db/db";
import { ingest } from "../lib/api";
import { ingestViaRelay } from "../lib/proxyIngest";
import { processReferenceFile } from "../lib/media";
import { getSample, sampleSupportsImages } from "../lib/runtime";
import { countImages, MAX_IMAGES_PER_REQUEST, referencesToAttachments } from "../lib/references";
import { readZip } from "../lib/zip";
import { useChat } from "./chat";
import { aiAvailable, needsApiKey, useStudio } from "./studio";

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
  /** false cuando reintentar daría el mismo error (p. ej. formato no soportado) */
  canRetry?: boolean;
  /** La vista no puede enviar imágenes: se pide una descripción escrita (plan B) */
  needsDescription?: boolean;
  /** Aviso informativo sobre el resultado */
  note?: string;
  usesAi: boolean;
}

export type Precision = "exact" | "fast";

interface EasyState {
  mode: Mode;
  /** Precisión del clonado con IA: «exact» (esfuerzo alto, más lento) o «fast» (ajuste normal) */
  precision: Precision;
  setPrecision(p: Precision): void;
  stage: Stage;
  job: Job | null;
  /** Notas por proyecto sobre cómo se clonó (se muestran en el resultado) */
  notes: Record<string, string>;
  setMode(mode: Mode): void;
  goHome(): void;
  openResult(projectId: string): Promise<void>;
  cloneUrl(url: string): Promise<void>;
  cloneFiles(files: File[]): Promise<void>;
  /** Plan B cuando la vista no puede enviar imágenes: clona a partir de una descripción escrita */
  cloneFromDescription(description: string): Promise<void>;
  retry(): Promise<void>;
  cancel(): void;
}

const MODE_KEY = "devstudio:mode";
const PRECISION_KEY = "devstudio:precision";

function readPrecision(): Precision {
  try {
    return localStorage.getItem(PRECISION_KEY) === "fast" ? "fast" : "exact";
  } catch {
    return "exact";
  }
}
const VISUAL_RE = /\.(png|jpe?g|webp|gif|bmp|avif|svg|mp4|webm|mov|m4v|ogv|pdf)$/i;
const CODE_RE = /\.(html?|css|m?js|json|txt|md|xml|svg)$/i;
const DOC_RE = /\.(txt|md|markdown|csv|json|xml)$/i;
const MAX_DOC_CHARS = 60_000;

let abortController: AbortController | null = null;
let lastInput: { kind: "url"; url: string } | { kind: "files"; files: File[] } | null = null;
/** Referencias ya procesadas a la espera de la descripción del usuario (plan B) */
let pendingDescribe: { projectId: string; refs: db.VisualReference[]; extra: ChatAttachment[]; labels: string[] } | null = null;

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

const CLONE_PROMPT = `Clona EXACTAMENTE la interfaz que aparece en los archivos adjuntos, como si fuera una copia pixel a pixel.
- Copia literalmente todos los textos visibles (títulos, menús, botones, precios, pies de página), sin resumir ni traducir.
- Reproduce la misma estructura, el mismo orden de secciones y las mismas proporciones: anchos, altos, márgenes y espaciados relativos al tamaño de la captura indicado.
- Usa los colores exactos de la captura (la paleta extraída te ayuda) y la tipografía más parecida de Google Fonts, con los mismos tamaños y pesos relativos.
- Reproduce iconos, bordes, sombras, esquinas redondeadas y fondos (gradientes incluidos). Para fotos usa bloques del mismo color dominante.
- Si la captura es de móvil (vertical y estrecha), el diseño principal debe ser el móvil; si es de escritorio, el de escritorio. Añade además adaptación responsive.
- Crea una página completa y funcional: index.html, styles.css y script.js.`;

const DESCRIBE_PROMPT = `No puedes ver la imagen original: esta vista no permite enviar imágenes.
Crea la interfaz a partir de la DESCRIPCIÓN del usuario y de los datos extraídos de la captura (paleta de colores dominante y tamaño).
- Usa esa paleta como colores principales de la página.
- Si la captura es vertical y estrecha, es una pantalla de móvil: diseña primero para móvil.
- Crea una página completa y funcional: index.html, styles.css y script.js, responsive.
- Si la descripción es breve, completa con contenido de ejemplo coherente.`;

/** ¿Puede esta vista enviar imágenes? Usa el valor ya detectado o lo comprueba ahora. */
async function webImagesOk(): Promise<boolean> {
  const known = useStudio.getState().webImages;
  if (known !== null) return known;
  const sample = await getSample();
  const ok = sample ? await sampleSupportsImages(sample) : false;
  useStudio.setState({ webImages: ok });
  return ok;
}

/** Datos de las referencias en texto (sin imágenes) para el plan B */
function describeRefs(refs: db.VisualReference[]): string {
  return refs
    .map((r) => {
      const size = r.width && r.height ? `${r.width}×${r.height} px (${r.height > r.width * 1.3 ? "vertical, probablemente móvil" : r.width > r.height * 1.3 ? "horizontal, probablemente escritorio" : "cuadrada"})` : "tamaño desconocido";
      return `- ${r.name}: ${r.kind === "video" ? `vídeo de ${Math.round(r.duration ?? 0)} s` : "imagen"}, ${size}; paleta dominante: ${r.palette.join(", ") || "no disponible"}`;
    })
    .join("\n");
}

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

  /** Envía la petición a la IA y termina el trabajo con la vista previa o un error comprensible */
  const runAi = async (prompt: string, attachments: ChatAttachment[], labels: string[], extra: { webFetch?: boolean; note?: string } = {}) => {
    advance(1);
    const unsubscribe = useChat.subscribe((s) => {
      if (s.streamText.includes("<file")) advance(2);
    });
    try {
      // Precisión máxima: esfuerzo alto (más lento). Rápida: el ajuste normal. Los cambios posteriores siempre usan el normal.
      await useChat.getState().send(prompt, {
        attachments,
        attachmentLabels: labels,
        mode: "generate-from-reference",
        webFetch: extra.webFetch,
        effort: get().precision === "exact" ? "high" : undefined,
      });
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
    finish(last?.meta?.error ? "La IA avisó de un problema y el resultado puede estar incompleto. Puedes pedirle que lo termine." : extra.note);
  };

  return {
    mode: readMode(),
    precision: readPrecision(),

    setPrecision(precision) {
      try {
        localStorage.setItem(PRECISION_KEY, precision);
      } catch {
        /* sin almacenamiento */
      }
      set({ precision });
    },
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
      const signal = abortController.signal;
      const host = new URL(url).hostname;
      const studioState = useStudio.getState();

      // Clonado EXACTO (código HTML y CSS reales): con servidor propio, o sin él mediante un servicio de reenvío
      const exact = studioState.health ? "server" : studioState.ai === "direct" ? "relay" : null;
      if (!exact) {
        set({
          stage: "working",
          job: { kind: "url", title: `Clonar ${host}`, usesAi: false, steps: [{ label: "Descargando la página", state: "active" }] },
        });
        fail(
          studioState.ai === "claude"
            ? "Desde el navegador no se pueden descargar otras webs. Haz una captura de pantalla de la web y súbela: la IA la clonará."
            : "Clonar por enlace necesita la app en tu ordenador (npm run dev). Mientras tanto, puedes subir una captura de la web.",
          { canRetry: false },
        );
        return;
      }
      const download = (o: { url: string; keepScripts: boolean }) =>
        exact === "server" ? ingest(o, signal) : ingestViaRelay({ ...o, url: /^https?:\/\//i.test(o.url) ? o.url : url });

      set({
        stage: "working",
        job: {
          kind: "url",
          title: `Clonando ${host}`,
          usesAi: false,
          steps: [
            { label: "Descargando el código original de la página", state: "active" },
            { label: "Copiando estilos, imágenes y estructura", state: "pending" },
            { label: "Preparando la vista previa", state: "pending" },
          ],
        },
      });

      try {
        let result = await download({ url: typed, keepScripts: false });
        if (signal.aborted) return;
        advance(1);
        let note: string | undefined;
        if (result.looksClientRendered) {
          setSteps((steps) => [
            ...steps.slice(0, 2),
            { label: "La web se construye con JavaScript: clonándola con sus scripts", state: "active" },
            ...steps.slice(2),
          ]);
          result = await download({ url: result.finalUrl, keepScripts: true });
          if (signal.aborted) return;
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
        abortController = null;
        finish(note);
        return;
      } catch (err) {
        if ((err as Error).name === "AbortError" || signal.aborted) return;
        if (exact === "server") {
          abortController = null;
          fail(friendlyUrlError((err as Error).message));
          return;
        }
        // Sin servidor y sin servicio de reenvío disponible: la IA lee la web y la reconstruye
      }
      abortController = null;

      set({
        stage: "working",
        job: {
          kind: "url",
          title: `Clonando ${host}`,
          usesAi: true,
          steps: [
            { label: "No se pudo descargar el código original: lo hará la IA", state: "done" },
            { label: "La IA está visitando la web", state: "active" },
            { label: "Construyendo la página", state: "pending" },
            { label: "Preparando la vista previa", state: "pending" },
          ],
        },
      });
      if (needsApiKey(useStudio.getState())) {
        fail("Para clonar esta web necesitas conectar la IA (solo una vez).", { needsKey: true });
        return;
      }
      try {
        await useStudio.getState().createProject({
          name: host,
          files: { "index.html": "", "styles.css": "", "script.js": "" },
          origin: { type: "url", detail: url },
        });
        await runAi(
          `Usa la herramienta web_fetch para leer ${url} y clona esa página con la máxima fidelidad posible.
- Reproduce su estructura, secciones, textos, navegación, formularios y enlaces principales.
- Deduce el estilo visual (colores, tipografía, espaciados) de la marca y del contenido; usa las imágenes de la página por su URL absoluta cuando aparezcan.
- Crea una página completa: index.html, styles.css y script.js, responsive.
- Si no puedes leer la página, dilo claramente en la explicación y no inventes su contenido.`,
          [],
          [],
          {
            webFetch: true,
            note: "No se pudo descargar el código original de esta web, así que la IA la ha reconstruido a partir de su contenido: los textos son fieles y el diseño puede variar. Para más exactitud, sube también una captura.",
          },
        );
      } catch (err) {
        fail(friendlyAiError((err as Error).message));
      }
    },

    async cloneFiles(files) {
      if (!files.length) return;
      lastInput = { kind: "files", files };
      pendingDescribe = null;
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
          { canRetry: false },
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
      if (needsApiKey(studio)) {
        fail("Para clonar desde imágenes, vídeos o documentos necesitas conectar la IA (solo una vez).", { needsKey: true });
        return;
      }
      if (!aiAvailable(studio)) {
        fail("La IA no está disponible aquí. Abre esta página desde claude.ai o usa la app en tu ordenador (npm run dev).");
        return;
      }
      if (studio.ai === "claude" && visuals.some((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name)) && visuals.every((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name))) {
        fail("La versión web no puede leer PDF. Haz una captura de la página del PDF y súbela como imagen.", { canRetry: false });
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

        // Plan B: esta vista no puede enviar imágenes → se pide una descripción escrita
        if (studio.ai === "claude" && countImages(attachments) > 0 && !(await webImagesOk())) {
          pendingDescribe = { projectId: project.id, refs, extra, labels };
          advance(1);
          fail(
            "Desde aquí no se pueden enviar imágenes a la IA (depende de la app o navegador donde abres la página). Describe con tus palabras lo que se ve en la captura y la IA lo creará con los colores que he sacado de ella.",
            { needsDescription: true, canRetry: false },
          );
          return;
        }

        await runAi(CLONE_PROMPT, all, labels);
      } catch (err) {
        fail(friendlyAiError((err as Error).message));
      }
    },

    async cloneFromDescription(description) {
      const pending = pendingDescribe;
      const text = description.trim();
      if (!pending || !text) return;
      const job = get().job;
      if (!job) return;
      set({ job: { ...job, error: undefined, needsDescription: false, canRetry: undefined } });
      try {
        if (useStudio.getState().project?.id !== pending.projectId) await useStudio.getState().openProject(pending.projectId);
        const attachments: ChatAttachment[] = [
          { type: "text", label: "Datos extraídos de la captura", text: describeRefs(pending.refs) },
          { type: "text", label: "Descripción del usuario", text },
          ...pending.extra,
        ];
        await runAi(DESCRIBE_PROMPT, attachments, pending.labels);
        if (get().stage === "result") pendingDescribe = null;
      } catch (err) {
        fail(friendlyAiError((err as Error).message));
      }
    },
  };
});

function friendlyUrlError(message: string): string {
  if (/servidor local/i.test(message)) return "No se puede clonar por enlace sin la app en tu ordenador (npm run dev). Puedes subir una captura de la web.";
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
