/**
 * Modo fácil: clonado automático a partir de una URL o de cualquier archivo
 * (captura, vídeo, PDF, SVG, HTML o ZIP), con pasos visibles y vista previa final.
 */
import { create } from "zustand";
import type { ChatAttachment, FileMap } from "../../shared/types";
import * as db from "../db/db";
import { ingest } from "../lib/api";
import { fetchSiteScreenshot, ingestViaRelay } from "../lib/proxyIngest";
import { processReferenceFile } from "../lib/media";
import { getSample, sampleSupportsImages } from "../lib/runtime";
import { countImages, MAX_IMAGES_PER_REQUEST, referencesToAttachments } from "../lib/references";
import { readZip } from "../lib/zip";
import { cssViewport, probeRender, renderSnapshot } from "../lib/snapshot";
import { compareImages } from "../lib/compare";
import { dataUrlParts } from "../lib/util";
import { useChat } from "./chat";
import { aiAvailable, needsApiKey, useStudio } from "./studio";

export type Mode = "easy" | "advanced";
export type Stage = "start" | "ask" | "working" | "result";

/** Entrada pendiente de confirmar: se muestra la pantalla «¿Qué quieres que haga?» antes de crear */
export type PendingInput = { kind: "url"; url: string; label: string } | { kind: "files"; files: File[]; label: string; previews: string[] };
export type StepState = "pending" | "active" | "done" | "error";

export interface Step {
  label: string;
  state: StepState;
}

export interface Job {
  kind: "url" | "files" | "prompt";
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
  /** Entrada pendiente y pantalla de instrucciones antes de crear */
  pending: PendingInput | null;
  askFiles(files: File[]): void;
  askUrl(url: string): void;
  startPending(instruction: string): Promise<void>;
  cancelAsk(): void;
  cloneUrl(url: string, instruction?: string): Promise<void>;
  cloneFiles(files: File[], instruction?: string): Promise<void>;
  /** Plan B cuando la vista no puede enviar imágenes: clona a partir de una descripción escrita */
  cloneFromDescription(description: string): Promise<void>;
  retry(): Promise<void>;
  cancel(): void;
  /** «Afinar más»: desde la pantalla de resultado, otra ronda de comparación con la captura original */
  refining: boolean;
  refineMore(projectId: string): Promise<void>;
  /** Crear desde cero: la IA construye exactamente lo que describas, sin partir de ninguna captura ni enlace */
  createFromPrompt(prompt: string, search?: boolean): Promise<void>;
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
/** Texto típico del aviso que muestran las webs cuando JavaScript no se ejecuta (en varios idiomas). */
export const NOSCRIPT_RE = /\b(enable|activ\w*|habilit\w*|requier\w*|necesit\w*|please\s+enable)\s+javascript\b|\bjavascript\s+(is\s+)?(disabled|desactivad[oa]|requer[ei]d?o|necesari[oa])\b|\bneed(s|a)?\s+javascript\b/i;
const VISUAL_RE = /\.(png|jpe?g|webp|gif|bmp|avif|svg|mp4|webm|mov|m4v|ogv|pdf)$/i;
const CODE_RE = /\.(html?|css|m?js|json|txt|md|xml|svg)$/i;
const DOC_RE = /\.(txt|md|markdown|csv|json|xml)$/i;
const MAX_DOC_CHARS = 60_000;

let abortController: AbortController | null = null;
let lastInput:
  | { kind: "url"; url: string; instruction?: string }
  | { kind: "files"; files: File[]; instruction?: string }
  | { kind: "prompt"; prompt: string; search?: boolean }
  | null = null;
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

const CLONE_PROMPT = `Clona EXACTAMENTE la interfaz de los archivos adjuntos: una copia píxel a píxel, no una interpretación.
- Recorre la captura de arriba abajo (todas sus partes) y reproduce cada sección, en el mismo orden, con todos sus textos copiados literalmente.
- Mismas medidas en px CSS (usa el ancho de pantalla estimado), mismos colores exactos, misma tipografía y pesos, mismos bordes, sombras, radios y fondos.
- Fotos, logotipos (también de marcas conocidas), ilustraciones e iconos complejos: recórtalos de la captura con captura:<id>#x,y,ancho,alto. Nunca los sustituyas por un bloque de color liso, una forma genérica o un SVG inventado: eso cuenta como no haber hecho la tarea.
- Si la captura es de móvil, el diseño principal es el de móvil; si es de escritorio, el de escritorio. En cualquier caso, añade reglas @media que reorganicen la maquetación (columnas que se apilan, menú hamburguesa, letra más pequeña) en los demás tamaños de pantalla: nunca dejes que en una pantalla distinta a la de la captura el diseño se vea amontonado, solapado o recortado.
- Crea una página completa y funcional: index.html, styles.css y script.js.`;

const refinePrompt = (score: number, parts: number) => `Revisión píxel a píxel (parecido actual: ${Math.round(score * 100)} %).
Te adjunto ${parts > 1 ? `${parts} imágenes, de arriba abajo de la página,` : "una imagen"} con la captura ORIGINAL a la izquierda y TU VERSIÓN a la derecha, pintada con tu código al mismo ancho de pantalla. Las zonas en rojo son las que no coinciden.
Corrige TODAS las diferencias, empezando por las más grandes:
1. Estructura: secciones que faltan, sobran o están en otro orden; elementos desplazados. Si tu versión es más alta o más baja que el original, ajusta alturas, márgenes y rellenos hasta que cada sección empiece a la misma altura.
2. Medidas: anchos, altos, márgenes, rellenos, tamaños de letra, interlineado y radios (mídelos en el original).
3. Colores de fondo, de texto y de bordes; sombras; tipografía y pesos.
4. Imágenes: si una imagen, foto o logotipo no coincide, o si ves un bloque de color liso o una forma genérica donde el original tiene una imagen o un logotipo real, recórtalo de la captura con captura:<id>#x,y,ancho,alto (revisa las coordenadas si el recorte salió desplazado o vacío). Un bloque de color liso en el lugar de un logotipo SIEMPRE es una diferencia que corregir, nunca lo des por válido.
- No cambies lo que ya coincide ni añadas nada que no esté en el original.
- Las imágenes externas (url() o <img> a una dirección de internet, no un recorte captura:) pueden no verse en esta comparación por no tener conexión aquí: esas sí puedes ignorarlas. Pero un recorte captura: que salió como bloque de color si cuenta como diferencia.
Explica en una frase qué has corregido y devuelve los ficheros corregidos completos.`;

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

/**
 * Genera una miniatura pequeña del resultado para la galería «Tus clones». Se hace en segundo plano
 * (no bloquea el resultado) y, si falla, no pasa nada: el proyecto se queda sin miniatura.
 */
function scheduleThumbnail(projectId: string, files: FileMap, viewport: { width: number; height: number }): void {
  renderSnapshot(files, viewport, { maxWidth: 320, timeoutMs: 12_000 })
    .then((dataUrl) => {
      // Solo se guarda si el proyecto sigue existiendo (pudo borrarse o cambiar mientras tanto)
      if (useStudio.getState().project?.id === projectId) useStudio.getState().patchProject({ thumbnail: dataUrl });
    })
    .catch(() => {
      /* sin miniatura: no es grave */
    });
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
    const project = useStudio.getState().project;
    const id = project?.id;
    const notes = { ...get().notes };
    if (id) {
      if (note) notes[id] = note;
      else delete notes[id];
    }
    setSteps((steps) => steps.map((s) => ({ ...s, state: "done" })));
    set({ stage: "result", notes });
    // Miniatura para la galería «Tus clones» (en segundo plano; si falla, no pasa nada)
    if (id && project && !project.thumbnail && Object.values(project.files).some((c) => c.trim())) {
      const w = project.viewport === "mobile" ? 390 : project.viewport === "tablet" ? 820 : 1280;
      const h = project.viewport === "mobile" ? 844 : project.viewport === "tablet" ? 1180 : 800;
      scheduleThumbnail(id, project.files, { width: w, height: h });
    }
  };

  /** Envía la petición a la IA y termina el trabajo con la vista previa o un error comprensible */
  const runAi = async (
    prompt: string,
    attachments: ChatAttachment[],
    labels: string[],
    extra: {
      webFetch?: boolean;
      webSearch?: boolean;
      note?: string;
      refine?: () => Promise<string | undefined>;
      mode?: "edit" | "generate-from-reference";
    } = {},
  ) => {
    advance(1);
    const unsubscribe = useChat.subscribe((s) => {
      if (s.streamText.includes("<file")) advance(2);
    });
    try {
      // La precisión máxima se consigue con la pasada de comparación (refine), no subiendo el esfuerzo: así no tarda minutos
      await useChat.getState().send(prompt, {
        attachments,
        attachmentLabels: labels,
        mode: extra.mode ?? "generate-from-reference",
        webFetch: extra.webFetch,
        webSearch: extra.webSearch,
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
    let refineNote: string | undefined;
    if (extra.refine && !last?.meta?.error) {
      advance(3);
      refineNote = await extra.refine();
      if (get().stage !== "working") return;
    }
    advance((get().job?.steps.length ?? 4) - 1);
    finish(last?.meta?.error ? "La IA avisó de un problema y el resultado puede estar incompleto. Puedes pedirle que lo termine." : (extra.note ?? refineNote));
  };

  /**
   * Pasadas de comparación (precisión máxima): pinta el clon al tamaño de la captura, lo compara con el
   * original, marca en rojo lo que no coincide y la IA lo corrige. Se repite mientras mejore y al final se
   * conserva la versión más parecida. Si algo falla, se queda el resultado que ya había.
   */
  const refineAgainst = async (
    ref: db.VisualReference,
    rounds = 1,
    opts: { guard?: () => boolean; onLabel?: (text: string) => void } = {},
  ): Promise<string | undefined> => {
    const guard = opts.guard ?? (() => get().stage === "working");
    const onLabel =
      opts.onLabel ?? ((text: string) => setSteps((steps) => steps.map((st, i) => (i === 3 && st.label.startsWith("Comparando") ? { ...st, label: text } : st))));
    const original = ref.full ?? ref.frames[0];
    if (!original || !ref.width || !ref.height) return;
    const viewport = cssViewport(ref.width, ref.height);
    const measure = async () => {
      const files = useStudio.getState().project!.files;
      const shot = await renderSnapshot(files, viewport);
      return { files, cmp: await compareImages(original, shot) };
    };

    let current: Awaited<ReturnType<typeof measure>>;
    try {
      current = await measure();
    } catch (err) {
      console.warn("Comparación visual omitida:", (err as Error).message);
      return;
    }
    let best = { files: current.files, score: current.cmp.score };
    for (let round = 1; round <= rounds; round++) {
      if (!guard() || best.score >= 0.985) break;
      onLabel(`Comparando con tu captura y corrigiendo diferencias (ronda ${round}/${rounds} · parecido ${Math.round(current.cmp.score * 100)} %)`);
      const attachments: ChatAttachment[] = current.cmp.composites.map((c, i) => {
        const { mediaType, data } = dataUrlParts(c);
        return { type: "image", mediaType: mediaType as "image/jpeg", data, label: `Comparación ${i + 1}/${current.cmp.composites.length}` };
      });
      attachments.push({
        type: "text",
        text: `Datos de la captura: id ${ref.id}; imagen completa ${ref.fullWidth ?? ref.width}×${ref.fullHeight ?? ref.height} px; ancho de pantalla ${viewport.width} px CSS.`,
      });
      await useChat.getState().send(refinePrompt(current.cmp.score, current.cmp.composites.length), {
        attachments,
        attachmentLabels: [`${ref.name} (comparación ${round})`],
        mode: "generate-from-reference",
      });
      if (!guard()) return;
      if (useChat.getState().messages.at(-1)?.meta?.error) break;
      const before = best.score;
      try {
        current = await measure();
      } catch {
        break;
      }
      if (current.cmp.score > best.score) best = { files: current.files, score: current.cmp.score };
      if (current.cmp.score - before < 0.003) break; // ya no mejora
    }
    // Se queda la versión más parecida a la captura
    const now = useStudio.getState().project?.files;
    if (now && now !== best.files) {
      const deleted = Object.keys(now).filter((p) => !(p in best.files));
      await useStudio.getState().applyChanges({ ...best.files }, deleted, "Versión más parecida a la captura", "ai");
    }
    return `Parecido con tu captura: ${Math.round(best.score * 100)} %. Si ves alguna diferencia, escríbela abajo (por ejemplo «el título es más grande») y la IA la corrige.`;
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
    pending: null,
    refining: false,

    askFiles(files) {
      if (!files.length) return;
      const previews = files.filter((f) => f.type.startsWith("image/")).slice(0, 6).map((f) => URL.createObjectURL(f));
      const label = files.length === 1 ? files[0].name : `${files.length} archivos`;
      set({ stage: "ask", pending: { kind: "files", files, label, previews } });
    },

    askUrl(raw) {
      const url = normalizeUrl(raw);
      if (!url) {
        useStudio.getState().toast("Esa dirección no parece válida. Prueba algo como «ejemplo.com».", "error");
        return;
      }
      set({ stage: "ask", pending: { kind: "url", url: raw.trim(), label: new URL(url).hostname } });
    },

    async startPending(instruction) {
      const p = get().pending;
      if (!p) return;
      set({ pending: null });
      if (p.kind === "files") await get().cloneFiles(p.files, instruction.trim() || undefined);
      else await get().cloneUrl(p.url, instruction.trim() || undefined);
    },

    cancelAsk() {
      const p = get().pending;
      if (p?.kind === "files") p.previews.forEach((u) => URL.revokeObjectURL(u));
      set({ stage: "start", pending: null });
    },

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
      // Si lo cancelado no llegó a construir nada usable, se borra para no dejar un «clon» vacío y
      // fantasma en la galería de «Tus clones» (no se espera a que termine: no debe frenar la navegación)
      const prev = useStudio.getState().project;
      if (prev && !Object.values(prev.files).some((c) => c.trim().length > 0)) {
        void db.deleteProjectCascade(prev.id).then(() => {
          useStudio.setState({ projects: useStudio.getState().projects.filter((p) => p.id !== prev.id) });
        });
      }
      set({ stage: "start", job: null });
    },

    async retry() {
      const input = lastInput;
      if (!input) return;
      // Cada intento crea un proyecto nuevo; si el anterior falló sin llegar a construir nada usable
      // (p. ej. se cortó la conexión antes de terminar ni un fichero), se borra antes de reintentar para
      // no dejar un «clon» vacío y fantasma en la galería de «Tus clones».
      const prev = useStudio.getState().project;
      if (prev && !Object.values(prev.files).some((c) => c.trim().length > 0)) {
        await db.deleteProjectCascade(prev.id);
        useStudio.setState({ projects: useStudio.getState().projects.filter((p) => p.id !== prev.id) });
      }
      if (input.kind === "url") await get().cloneUrl(input.url, input.instruction);
      else if (input.kind === "files") await get().cloneFiles(input.files, input.instruction);
      else await get().createFromPrompt(input.prompt, input.search);
    },

    async cloneUrl(raw, instruction) {
      const url = normalizeUrl(raw);
      if (!url) {
        useStudio.getState().toast("Esa dirección no parece válida. Prueba algo como «ejemplo.com».", "error");
        return;
      }
      // Se envía tal cual la escribió el usuario: sin protocolo, el servidor prueba HTTPS y luego HTTP
      const typed = raw.trim();
      lastInput = { kind: "url", url: typed, instruction };
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
        // Precisión máxima: se conservan los scripts originales (menús, carruseles, animaciones y webs hechas con JavaScript)
        const keepScripts = get().precision === "exact";
        let result = await download({ url: typed, keepScripts });
        if (signal.aborted) return;
        advance(1);
        let note: string | undefined;
        if (result.looksClientRendered && !keepScripts) {
          setSteps((steps) => [
            ...steps.slice(0, 2),
            { label: "La web se construye con JavaScript: clonándola con sus scripts", state: "active" },
            ...steps.slice(2),
          ]);
          result = await download({ url: result.finalUrl, keepScripts: true });
          if (signal.aborted) return;
        }
        let files = result.files;
        if (result.staticFiles) {
          // ¿Funcionan los scripts de la web fuera de ella? Se abren las dos versiones y se elige la que muestra la página completa
          setSteps((steps) => steps.map((st, i) => (i === 1 ? { ...st, label: "Comprobando que el clon se ve igual que la web" } : st)));
          const [withJs, without] = await Promise.all([
            probeRender(result.files, { baseUrl: result.finalUrl }),
            probeRender(result.staticFiles, { baseUrl: result.finalUrl }),
          ]);
          if (signal.aborted) return;
          // Si la versión sin scripts es solo un aviso de "activa JavaScript" (lo único que vería alguien
          // con JS desactivado), no sirve de nada compararla por cantidad de texto: ese aviso puede ser
          // más largo que el contenido real ya desbloqueado, y la comparación por tamaño elegiría por error
          // el aviso en vez de la página real.
          const staticIsNoScriptNotice = !!without && NOSCRIPT_RE.test(without.sample);
          const scriptsWork = !!withJs && withJs.text >= 20 && (staticIsNoScriptNotice || !without || (withJs.text >= without.text * 0.6 && withJs.visible >= without.visible * 0.5));
          if (!scriptsWork) {
            files = result.staticFiles;
            note = "Los scripts de esta web no funcionan fuera de ella, así que el clon muestra la página tal como se ve, pero sin sus animaciones ni menús desplegables.";
          }
        }
        if (result.looksClientRendered && files === result.files)
          note =
            "Esta web se genera con JavaScript, así que el clon conserva sus scripts. Algunas partes (inicio de sesión, datos en vivo) pueden no funcionar fuera de la web original.";
        advance(result.looksClientRendered && !keepScripts ? 3 : 2);
        const { files: _all, staticFiles: _static, ...report } = result;
        await useStudio.getState().createProject({
          name: result.title ? result.title.slice(0, 60) : host,
          files,
          origin: { type: "url", detail: result.finalUrl },
          ingest: report,
          message: `Clon de ${result.finalUrl}`,
          source: "ingest",
        });
        // Un clon exacto no debe recibir librerías añadidas automáticamente (cambiarían su aspecto)
        useStudio.getState().setAutoInjectDeps(false);
        // Cuando la web se generaba con JavaScript, lo que se guardó es una foto fija de cómo la pintó un
        // navegador (sin sus scripts): se compara con una captura real de la web viva y se corrigen
        // diferencias, igual que ya se hace con las capturas subidas a mano, para no quedarse solo con la
        // aproximación. Funciona con cualquier IA configurada (gratuita u de pago), no hace falta nada especial.
        const paintedSnapshot = result.warnings.some((w) => w.includes("ya pintada por un navegador"));
        let refineNote: string | undefined;
        if (paintedSnapshot && keepScripts && aiAvailable(useStudio.getState())) {
          try {
            const shot = await fetchSiteScreenshot(result.finalUrl);
            if (shot && get().stage === "working") {
              const blob = await (await fetch(shot.dataUrl)).blob();
              const ref = await processReferenceFile(new File([blob], `${host}.jpg`, { type: blob.type || "image/jpeg" }), useStudio.getState().project!.id);
              await db.saveReference(ref);
              refineNote = await refineAgainst(ref, 2);
            }
          } catch {
            /* si la captura real o el afinado fallan, se deja el clon tal cual (ya es fiel al HTML pintado) */
          }
        }
        // Algunos avisos son menores y ya tienen su propio respaldo (p. ej. una fuente no copiada usa una
        // parecida; una hoja de estilos se enlaza directamente al original): no merecen la alarma genérica
        // de "incompleto". Solo se avisa así cuando el aviso es de verdad grave (la propia página falló, …).
        const MINOR_WARNING_RE = /fuente\(s\) no se pudieron copiar|se cargan directamente desde la web original|tipo de contenido inesperado|ya pintada por un navegador|se quitó.*aviso de cookies|imagen\(es\) no se pudieron descargar/i;
        if (refineNote) note = refineNote;
        if (!note) {
          const serious = result.warnings.filter((w) => !MINOR_WARNING_RE.test(w));
          if (serious.length) note = `Algunos recursos no se pudieron descargar, por lo que el clon puede verse incompleto: ${serious[0]}`;
          else if (result.warnings.length) note = paintedSnapshot ? "Esta web se genera con JavaScript; se comparó el clon con la web real para corregir diferencias." : result.warnings[0];
        }
        abortController = null;
        // Si diste una instrucción («júntalo con…», «cambia…», «instala solo el formulario de contacto»),
        // se aplica sobre el clon descargado. Se deja claro que el código ya descargado es el real de la
        // web (no hay que inventarlo) y que si la instrucción pide una parte concreta, hay que quedarse
        // solo con esa parte y quitar el resto, no limitarse a resaltarla o añadirla a la página completa.
        if (instruction && aiAvailable(useStudio.getState())) {
          finish(note);
          await useChat.getState().send(
            `El proyecto ya contiene el código real descargado de ${result.finalUrl} (no lo inventes ni lo reconstruyas de memoria: está en los ficheros del proyecto). Ahora aplica esta instrucción del usuario: "${instruction}". Si pide una parte concreta de la página (un formulario, una sección, un menú…), identifica ese fragmento exacto en el código descargado y deja el proyecto SOLO con esa parte (quita el resto), no te limites a señalarla o a añadir algo nuevo junto a la página completa.`,
          );
          return;
        }
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
        const project = await useStudio.getState().createProject({
          name: host,
          files: { "index.html": "", "styles.css": "", "script.js": "" },
          origin: { type: "url", detail: url },
        });
        // Una captura real de la web (hecha por un servicio externo) para que la IA copie el diseño exacto
        let ref: db.VisualReference | null = null;
        if (studioState.ai === "direct") {
          setSteps((steps) => steps.map((st, i) => (i === 1 ? { ...st, label: "Haciendo una captura de la web y leyendo su contenido" } : st)));
          const shot = await fetchSiteScreenshot(url);
          if (get().stage !== "working") return;
          if (shot) {
            try {
              const blob = await (await fetch(shot.dataUrl)).blob();
              ref = await processReferenceFile(new File([blob], `${host}.jpg`, { type: blob.type || "image/jpeg" }), project.id);
              await db.saveReference(ref);
            } catch {
              ref = null;
            }
          }
        }
        const refs = ref ? referencesToAttachments([ref]) : { attachments: [], labels: [] };
        if (ref && get().precision === "exact") {
          setSteps((steps) => [...steps.slice(0, 3), { label: "Comparando con la web y corrigiendo diferencias", state: "pending" }, ...steps.slice(3)]);
        }
        await runAi(
          `Clona ${url} con la máxima fidelidad, como una copia píxel a píxel.
${instruction ? `- INSTRUCCIÓN DEL USUARIO (prioritaria): ${instruction}. Si pide una parte concreta de la página (un formulario, una sección, un menú…), busca ESA parte exacta dentro de la web y quédate solo con ella (no entregues la página completa salvo que lo pida).\n` : ""}${ref ? "- Te adjunto una captura real de la página: copia su diseño EXACTO (estructura, medidas, colores, tipografía, imágenes) siguiendo las reglas de referencia visual.\n" : ""}- Usa la herramienta web_fetch para leer ${url} y copiar literalmente sus textos, enlaces y navegación.
- Usa las imágenes de la página por su URL absoluta cuando aparezcan${ref ? " o recórtalas de la captura con captura:<id>#x,y,ancho,alto" : ""}.
- Crea una página completa: index.html, styles.css y script.js, responsive.
- Si no puedes leer la página, dilo claramente en la explicación y no inventes su contenido.`,
          refs.attachments,
          refs.labels,
          {
            webFetch: true,
            // Antes, cuando sí se conseguía una captura, no se avisaba de nada: el usuario recibía una
            // reconstrucción de la IA creyendo que era la descarga exacta del código. Ahora se avisa
            // siempre que se cae a este camino (la web bloqueó la descarga automática de su código),
            // para que quede claro por qué esto no es una copia exacta del código original.
            note: ref
              ? "Esta web bloqueó la descarga automática de su código (algunas lo hacen a propósito), así que la IA la ha reconstruido a partir de una captura real: el diseño y las imágenes visibles se parecen mucho, pero no es una copia exacta del código, y las partes que dependen del servidor original (inicio de sesión, formularios reales, datos en vivo) no van a funcionar. Para que la descarga exacta tenga más posibilidades, prueba a configurar tu propio servidor de descarga (proxy) en Ajustes."
              : "No se pudo descargar el código original de esta web, así que la IA la ha reconstruido a partir de su contenido: los textos son fieles y el diseño puede variar. Para más exactitud, sube también una captura.",
            refine: ref && get().precision === "exact" ? () => refineAgainst(ref!, 2) : undefined,
          },
        );
      } catch (err) {
        fail(friendlyAiError((err as Error).message));
      }
    },

    async cloneFiles(files, instruction) {
      if (!files.length) return;
      lastInput = { kind: "files", files, instruction };
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
            ...(get().precision === "exact" && visuals.some((f) => !/pdf|svg/i.test(f.type) && !/\.(pdf|svg)$/i.test(f.name))
              ? [{ label: "Comparando con tu captura y corrigiendo diferencias", state: "pending" as const }]
              : []),
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
        // Cada archivo se procesa de forma independiente (recorte, paleta, fotogramas): se hace en
        // paralelo en vez de uno detrás de otro, para no sumar sus tiempos con varios archivos subidos
        const refs = await Promise.all(
          visuals.map(async (f) => {
            const ref = await processReferenceFile(f, project.id, { videoFrames: 8 });
            await db.saveReference(ref);
            return ref;
          }),
        );
        // La vista previa se abre con la misma pantalla que la captura (móvil, tablet u ordenador)
        const first = refs.find((r) => r.width && r.height);
        if (first) {
          const w = cssViewport(first.width!, first.height!).width;
          useStudio.getState().patchProject({ viewport: w < 600 ? "mobile" : w < 1000 ? "tablet" : "desktop" });
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

        const target = refs.find((r) => (r.kind === "image" || r.kind === "video") && r.frames.length && r.width && r.height);
        // Con instrucción (componer varias imágenes, secuencia, splash…) manda lo que pide el usuario y no se compara contra una sola captura
        const prompt = instruction
          ? `INSTRUCCIÓN DEL USUARIO (haz exactamente esto con los archivos adjuntos): ${instruction}

Completa el 100% de lo que pide la instrucción, de principio a fin: si menciona varias partes, secciones o pasos, ninguno puede quedar sin hacer o a medias. No te detengas tras cubrir solo una parte dando la tarea por terminada.

Como apoyo, estas son las reglas de fidelidad cuando reproduzcas una captura:
${CLONE_PROMPT}

Si la instrucción pide combinar varias imágenes, mostrarlas en orden, con tiempos o transiciones (por ejemplo un splash), impleméntalo con HTML/CSS/JS y usa las imágenes reales recortándolas de las capturas (captura:<id>#x,y,ancho,alto) o mostrándolas completas según convenga.`
          : CLONE_PROMPT;
        const refine = !instruction && get().precision === "exact" && target ? () => refineAgainst(target, 2) : undefined;
        await runAi(prompt, all, labels, { refine });
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

    async createFromPrompt(prompt, search) {
      const text = prompt.trim();
      if (!text) return;
      lastInput = { kind: "prompt", prompt: text, search };
      pendingDescribe = null;
      abortController = new AbortController();
      const studio = useStudio.getState();
      const title = text.length > 60 ? `${text.slice(0, 57)}…` : text;

      set({
        stage: "working",
        job: {
          kind: "prompt",
          title: "Creando desde cero",
          usesAi: true,
          steps: [
            { label: search ? "Buscando información en internet" : "Entendiendo lo que pides", state: "active" },
            { label: "Construyendo la página", state: "pending" },
            { label: "Preparando la vista previa", state: "pending" },
          ],
        },
      });
      if (needsApiKey(studio)) {
        fail("Para crear algo desde cero hace falta conectar la IA (solo una vez).", { needsKey: true });
        return;
      }
      if (!aiAvailable(studio)) {
        fail("La IA no está disponible aquí. Abre esta página desde claude.ai o usa la app en tu ordenador (npm run dev).");
        return;
      }
      if (search && studio.settings.aiProvider !== "gemini") {
        fail("Buscar en internet solo funciona con Google Gemini por ahora. Cambia a Gemini en Ajustes, o desmarca la casilla y prueba sin buscar.", {
          canRetry: false,
        });
        return;
      }
      try {
        await studio.createProject({
          name: title.replace(/[.!?]+$/, "").slice(0, 60) || "Proyecto nuevo",
          files: { "index.html": "", "styles.css": "", "script.js": "" },
          origin: { type: "blank", detail: text },
        });
        await runAi(
          `Crea EXACTAMENTE lo que te pide el usuario, ni más ni menos, sin añadir secciones o funciones que no haya pedido:
${text}
${search ? "\n- Antes de construir, BUSCA en internet la información real que necesites (datos, precios, nombres, hechos actuales) y úsala; no te la inventes.\n" : ""}
- Interpreta la petición de forma literal: si detalla textos, colores, secciones o un orden concreto, respétalo tal cual.
- Si algo queda ambiguo, elige la interpretación más razonable y dilo en una frase, pero no inventes funciones extra no pedidas.
- Crea una página completa y funcional: index.html, styles.css y script.js, con HTML semántico y accesible.
- Responsive de verdad: con @media que reorganicen la maquetación (columnas que se apilan, menú hamburguesa) en pantallas estrechas, y sin anchos fijos en los contenedores principales; pruébalo mentalmente tanto en escritorio como en móvil antes de darlo por terminado.
- Usa contenido de ejemplo realista donde el usuario no haya dado datos concretos.`,
          [],
          [],
          { mode: "edit", webSearch: search },
        );
      } catch (err) {
        fail(friendlyAiError((err as Error).message));
      }
    },

    async refineMore(projectId) {
      const studio = useStudio.getState();
      if (get().refining || useChat.getState().streaming) return;
      if (!aiAvailable(studio)) {
        studio.toast("Conecta la IA gratuita (clave de Google) en Ajustes.", "error");
        return;
      }
      set({ refining: true });
      try {
        const refs = await db.listReferences(projectId);
        const target = refs.find((r) => (r.kind === "image" || r.kind === "video") && r.frames.length && r.width && r.height);
        if (!target) {
          studio.toast("Este clon no tiene una captura original con la que comparar.", "info");
          return;
        }
        const note = await refineAgainst(target, 1, { guard: () => get().refining, onLabel: (text) => studio.toast(text, "info") });
        if (note) {
          const notes = { ...get().notes, [projectId]: note };
          set({ notes });
        }
        studio.toast("Comparación terminada", "success");
      } catch (err) {
        studio.toast(friendlyAiError((err as Error).message), "error");
      } finally {
        set({ refining: false });
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
