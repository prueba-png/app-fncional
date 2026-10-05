import { create } from "zustand";
import { hasCaptureRefs, resolveCrops } from "../lib/crops";
import { memoryAttachments, refersToOriginal } from "../lib/references";
import type { ChatAttachment, ChatTurn } from "../../shared/types";
import { omitLargeDataUris, parseFileBlocks, restoreDataUris } from "../../shared/fileBlocks";
import * as db from "../db/db";
import type { ChatMessage } from "../db/db";
import { streamChat } from "../lib/api";
import { getSample, sampleChat } from "../lib/runtime";
import { streamDirect } from "../lib/directAi";
import { streamGemini, streamOpenRouter } from "../lib/freeAi";
import { uid } from "../lib/util";
import { aiAvailable, useStudio } from "./studio";
import { FILE_CHAR_BUDGET_ANTHROPIC, FILE_CHAR_BUDGET_GEMINI, FILE_CHAR_BUDGET_OPENROUTER, filesContextChars, trimLinkedPagesForBudget } from "../../shared/prompts";

const HISTORY_TURNS = 12;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const rank = (e: string) => EFFORTS.indexOf(e as (typeof EFFORTS)[number]);

type StreamFn = (req: import("../../shared/types").ChatRequest, onEvent: (e: import("../../shared/types").ChatStreamEvent) => void, signal: AbortSignal) => Promise<void>;
interface ProviderAttempt {
  label: string;
  apiKey?: string;
  run: StreamFn;
  /** Caracteres de ficheros que admite este proveedor antes de rechazar la petición (ver shared/prompts). */
  charBudget: number;
}

/**
 * Lista ordenada de IA a probar: primero la elegida, después las demás que tengan clave.
 * Así, si una agota su cupo gratuito, la app usa otra sin que el usuario tenga que tocar nada.
 *
 * Si se pasa `requiredChars` (el tamaño real del proyecto en esta petición), los proveedores que
 * seguro que lo rechazarían por tamaño (su `charBudget` no llega) se prueban los últimos: así, por
 * ejemplo, un clon grande no falla solo por haberle tocado de primeras el modelo gratuito de OpenRouter
 * (contexto mucho más pequeño) cuando Gemini sí tendría sitio de sobra para el mismo proyecto.
 */
function buildProviderAttempts(studio: ReturnType<typeof useStudio.getState>, requiredChars?: number): ProviderAttempt[] {
  const s = studio.settings;
  const order: db.AiProvider[] = [s.aiProvider, ...(["gemini", "openrouter", "anthropic"] as db.AiProvider[]).filter((p) => p !== s.aiProvider)];
  const out: ProviderAttempt[] = [];
  for (const p of order) {
    if (p === "gemini" && s.geminiApiKey) out.push({ label: "Google Gemini", apiKey: s.geminiApiKey, run: streamGemini, charBudget: FILE_CHAR_BUDGET_GEMINI });
    else if (p === "openrouter" && s.openrouterApiKey) out.push({ label: "OpenRouter", apiKey: s.openrouterApiKey, run: streamOpenRouter, charBudget: FILE_CHAR_BUDGET_OPENROUTER });
    else if (p === "anthropic" && (s.anthropicApiKey || studio.health?.hasEnvApiKey))
      out.push({ label: "Anthropic", apiKey: s.anthropicApiKey || undefined, run: studio.ai === "direct" ? streamDirect : streamChat, charBudget: FILE_CHAR_BUDGET_ANTHROPIC });
  }
  if (requiredChars == null) return out;
  const fits = out.filter((a) => a.charBudget >= requiredChars);
  const tooSmall = out.filter((a) => a.charBudget < requiredChars);
  return [...fits, ...tooSmall];
}

/**
 * Reescribe una idea breve como un prompt más detallado (modo "Idealizar"), usando el mismo turno de
 * IA que «Crear desde cero» pero sin tocar el proyecto, el historial ni la vista previa: solo da texto.
 * Si una IA agota su cupo, salta a la siguiente exactamente igual que al aplicar un cambio.
 */
export async function improveIdea(idea: string, signal: AbortSignal): Promise<string> {
  const studio = useStudio.getState();
  const attempts = buildProviderAttempts(studio);
  if (!attempts.length) throw new Error("Conecta la IA gratuita (clave de Google) en Ajustes.");
  let text = "";
  let lastErr: unknown;
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    try {
      text = "";
      await a.run(
        {
          apiKey: a.apiKey,
          model: studio.settings.model,
          effort: studio.settings.effort,
          history: [],
          prompt: idea,
          files: {},
          mode: "improve-prompt",
        },
        (e) => {
          if (e.type === "text") text += e.text;
        },
        signal,
      );
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err;
      if ((err as Error).name === "AbortError") throw err;
      const name = (err as Error).name;
      if ((name === "QuotaError" || name === "NetworkError") && !text && i < attempts.length - 1) continue;
      throw err;
    }
  }
  if (lastErr) throw lastErr;
  if (!text.trim()) throw new Error("La IA no devolvió ningún texto. Inténtalo de nuevo.");
  return text.trim();
}

interface SendOptions {
  attachments?: ChatAttachment[];
  attachmentLabels?: string[];
  mode?: "edit" | "generate-from-reference";
  webFetch?: boolean;
  webSearch?: boolean;
  /** Sustituye el esfuerzo de los ajustes para esta petición (p. ej. «high» al clonar) */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

interface ChatState {
  projectId: string | null;
  messages: ChatMessage[];
  streaming: boolean;
  streamText: string;
  status: string;
  controller: AbortController | null;
  load(projectId: string): Promise<void>;
  send(prompt: string, opts?: SendOptions): Promise<void>;
  stop(): void;
  clear(): Promise<void>;
}

export const useChat = create<ChatState>((set, get) => ({
  projectId: null,
  messages: [],
  streaming: false,
  streamText: "",
  status: "",
  controller: null,

  async load(projectId) {
    if (get().projectId === projectId) return;
    get().stop();
    set({ projectId, messages: await db.listChat(projectId), streamText: "", status: "" });
  },

  stop() {
    get().controller?.abort();
  },

  async clear() {
    const id = get().projectId;
    if (!id) return;
    get().stop();
    await db.clearChat(id);
    set({ messages: [] });
  },

  async send(prompt, opts = {}) {
    const studio = useStudio.getState();
    const project = studio.project;
    if (!project || get().streaming || !prompt.trim()) return;
    if (get().projectId !== project.id) await get().load(project.id);

    const { settings } = studio;
    const useWeb = studio.ai === "claude";
    if (studio.ai === "none") {
      studio.toast("La IA no está disponible aquí. Abre la app con «npm run dev» en tu ordenador.", "error");
      return;
    }
    if (!useWeb && !aiAvailable(studio)) {
      studio.toast("Conecta la IA gratuita (clave de Google) en Ajustes.", "error");
      studio.setSettingsOpen(true);
      return;
    }

    // Memoria de las capturas originales: si el usuario menciona la captura/logo/imagen original y no adjunta
    // nada nuevo, se le vuelven a enviar a la IA las capturas con las que se creó el proyecto para que las consulte.
    let attachments = opts.attachments;
    if (!attachments?.length && refersToOriginal(prompt)) {
      try {
        const refs = await db.listReferences(project.id);
        const mem = memoryAttachments(refs);
        if (mem.length) attachments = mem;
      } catch {
        /* sin referencias guardadas */
      }
    }
    // El proyecto es un clon de una URL real: si este cambio puede usar la herramienta de navegación,
    // se recuerda cuál es esa URL para que la IA la visite de nuevo en vez de inventar los datos nuevos
    // que añada (el usuario espera que coincidan con la página oficial, no una aproximación).
    if (opts.webFetch && project.origin?.type === "url" && project.origin.detail) {
      attachments = [
        ...(attachments ?? []),
        {
          type: "text",
          text: `Este proyecto es un clon de la web real ${project.origin.detail}. Si este cambio necesita algún dato de esa página (texto, estructura, un elemento que falte, un valor exacto) visita esa URL con tu herramienta de navegación y úsalo tal cual, en vez de inventarlo o aproximarlo.`,
          label: "Web original del proyecto",
        },
      ];
    }

    const userMsg: ChatMessage = {
      id: uid("m_"),
      projectId: project.id,
      role: "user",
      content: prompt.trim(),
      createdAt: Date.now(),
      meta: opts.attachmentLabels?.length ? { attachments: opts.attachmentLabels } : undefined,
    };
    await db.saveChatMessage(userMsg);
    const history: ChatTurn[] = get()
      .messages.filter((m) => !m.meta?.error)
      .slice(-HISTORY_TURNS)
      .map((m) => ({ role: m.role, content: m.content }));
    const controller = new AbortController();
    set({ messages: [...get().messages, userMsg], streaming: true, streamText: "", status: "Conectando…", controller });

    let text = "";
    let model = settings.model;
    let usage: { input: number; output: number } | undefined;
    let stopReason: string | null = null;
    let error: string | undefined;

    // Imágenes o fuentes incrustadas a mitad de un fichero (p. ej. un @font-face en base64) pueden pesar
    // cientos de miles de caracteres sin que la IA necesite verlas para un cambio de texto o color: se
    // omiten del envío (y se reponen después si el fichero vuelve sin tocar esa parte), para no superar el
    // límite de tamaño de la petición por datos que la IA ni necesitaba leer.
    const { files: omittedFiles, restore: dataUriRestore } = omitLargeDataUris(useStudio.getState().project!.files);
    // Un proyecto con varias páginas clonadas (clonado multi-página) puede superar el presupuesto de
    // cualquier proveedor aunque el cambio pedido no tenga nada que ver con esas páginas adicionales: si
    // no cabe en ninguno, se omite el código de las páginas que el propio texto no menciona por su nombre,
    // en vez de fallar siempre con "el proyecto supera X caracteres".
    const bestBudget = Math.max(0, ...buildProviderAttempts(studio).map((a) => a.charBudget));
    const contextFiles = trimLinkedPagesForBudget(omittedFiles, prompt, bestBudget);
    const requiredChars = filesContextChars(contextFiles);

    try {
      await useStudio.getState().flush();
      const sample = useWeb ? await getSample() : null;
      if (useWeb) {
        if (!sample) throw new Error("La IA de claude.ai no está disponible en esta vista.");
        set({ status: "Pensando…" });
        const result = await sampleChat(
          sample,
          {
            history,
            prompt: userMsg.content,
            files: contextFiles,
            activeFile: project.activeFile,
            attachments,
            mode: opts.mode ?? "edit",
          },
          (t) => {
            text = t;
            set({ streamText: t });
          },
          controller.signal,
        );
        text = result.text;
        model = "Claude (tu cuenta de claude.ai)";
        stopReason = result.truncated ? "max_tokens" : "end_turn";
      } else {
        // Se prueban las IA disponibles en orden (la que tenga sitio de sobra para el tamaño real del
        // proyecto primero); si una agota su cupo gratuito o no tiene contexto suficiente, salta sola a la siguiente
        const attempts = buildProviderAttempts(studio, requiredChars);
        if (!attempts.length) throw new Error("Conecta la IA gratuita (clave de Google) en Ajustes.");
        const onEvent = (e: import("../../shared/types").ChatStreamEvent) => {
          if (e.type === "text") {
            text += e.text;
            set({ streamText: text });
          } else if (e.type === "status") set({ status: e.message });
          else if (e.type === "error") error = e.message;
          else if (e.type === "done") {
            model = e.model;
            usage = e.usage;
            stopReason = e.stopReason;
          }
        };
        let lastErr: unknown;
        for (let i = 0; i < attempts.length; i++) {
          const a = attempts[i];
          try {
            text = "";
            error = undefined;
            set({ streamText: "" });
            await a.run(
              {
                apiKey: a.apiKey,
                model: settings.model,
                effort: opts.effort && rank(opts.effort) > rank(settings.effort) ? opts.effort : settings.effort,
                history,
                prompt: userMsg.content,
                files: contextFiles,
                activeFile: project.activeFile,
                attachments,
                mode: opts.mode ?? "edit",
                webFetch: opts.webFetch,
                webSearch: opts.webSearch,
              },
              onEvent,
              controller.signal,
            );
            lastErr = undefined;
            break;
          } catch (err) {
            lastErr = err;
            if ((err as Error).name === "AbortError") throw err;
            const name = (err as Error).name;
            // Se salta al siguiente servicio con clave cuando se agotó el cupo, cuando el proyecto no cabe
            // en el contexto de este proveedor (lo probará el siguiente, con más sitio), o cuando la red
            // falló sin llegar a escribir nada (así no se pierde ni se duplica lo que ya se hubiera generado)
            if ((name === "QuotaError" || name === "NetworkError" || name === "SizeError") && !text && i < attempts.length - 1) {
              set({ status: `Cambiando a otra IA gratuita (${attempts[i + 1].label})…` });
              continue;
            }
            throw err;
          }
        }
        if (lastErr) throw lastErr;
      }
    } catch (err) {
      const partial = (err as { partial?: string }).partial;
      if (partial && partial.length > text.length) text = partial;
      if ((err as Error).name === "AbortError") error = "Generación detenida por el usuario.";
      else error = (err as Error).message;
    }

    let parsed = parseFileBlocks(text);
    if (parsed.incomplete && !error && !useWeb && !controller.signal.aborted) {
      // El modelo cortó un fichero a mitad (límite de salida del plan gratuito, o el flujo se interrumpió):
      // en vez de descartarlo, se le pide que continúe EXACTAMENTE desde donde lo dejó, una sola vez, antes
      // de rendirse. Se le da como historial su propia respuesta cortada para que sepa dónde seguir.
      try {
        set({ status: "Terminando el fichero cortado…" });
        const contAttempts = buildProviderAttempts(studio, requiredChars);
        const contHistory: ChatTurn[] = [...history, { role: "user", content: userMsg.content }, { role: "assistant", content: text }];
        let contText = "";
        let contErr: unknown;
        for (let i = 0; i < contAttempts.length; i++) {
          const a = contAttempts[i];
          try {
            contText = "";
            await a.run(
              {
                apiKey: a.apiKey,
                model: settings.model,
                effort: settings.effort,
                history: contHistory,
                prompt:
                  "Tu respuesta anterior se cortó a mitad de un bloque <file>. Continúa EXACTAMENTE desde el carácter siguiente a donde la dejaste: no repitas nada de lo ya escrito, no vuelvas a abrir la etiqueta <file>, termina ese fichero y ciérralo con </file>. Si quedaban más ficheros por escribir, continúa después con ellos en el mismo formato.",
                files: contextFiles,
                activeFile: project.activeFile,
                mode: opts.mode ?? "edit",
              },
              (e) => {
                if (e.type === "text") {
                  contText += e.text;
                  set({ streamText: text + contText });
                } else if (e.type === "done") {
                  model = e.model;
                  usage = e.usage;
                  stopReason = e.stopReason;
                }
              },
              controller.signal,
            );
            contErr = undefined;
            break;
          } catch (err) {
            contErr = err;
            if ((err as Error).name === "AbortError") throw err;
            if (!contText && i < contAttempts.length - 1) continue;
            throw err;
          }
        }
        if (!contErr && contText) {
          text += contText;
          parsed = parseFileBlocks(text);
        }
      } catch {
        /* si la continuación también falla, se deja como estaba y se avisa igual que antes */
      }
    }

    // Cada mensaje que se manda aquí es siempre una instrucción para cambiar el proyecto (esta app no tiene
    // un chat de preguntas sueltas): si el modelo (sobre todo los gratuitos) responde con texto —a veces
    // diciendo que ya lo ha hecho ("He corregido…"), a veces solo explicando lo que va a hacer y cortando
    // ahí— pero no incluye ningún bloque <file>, el chat parece contestar, pero nada se aplica de verdad.
    // Mientras haya texto de verdad (no una respuesta vacía) y ni un fichero ni un borrado, se le pide una
    // vez que devuelva YA el código, en vez de dejar al usuario con un cambio fantasma.
    if (!parsed.incomplete && !error && !Object.keys(parsed.updated).length && !parsed.deleted.length && !useWeb && !controller.signal.aborted && parsed.prose.trim().length > 0) {
      try {
        set({ status: "Pidiendo el cambio en código (la respuesta anterior no lo incluía)…" });
        const retryAttempts = buildProviderAttempts(studio, requiredChars);
        const retryHistory: ChatTurn[] = [...history, { role: "user", content: userMsg.content }, { role: "assistant", content: text }];
        let retryText = "";
        let retryErr: unknown;
        for (let i = 0; i < retryAttempts.length; i++) {
          const a = retryAttempts[i];
          try {
            retryText = "";
            await a.run(
              {
                apiKey: a.apiKey,
                model: settings.model,
                effort: settings.effort,
                history: retryHistory,
                prompt:
                  "Tu respuesta anterior no incluía ningún bloque <file>, así que en realidad no se aplicó ningún cambio al proyecto (da igual lo que dijeras o planearas hacer). Devuelve AHORA el bloque <file> COMPLETO de cada fichero que haya que cambiar, con el cambio ya hecho, en el formato exacto <file path=\"...\">…</file>. No repitas la explicación ni digas lo que vas a hacer: hazlo y entrega solo los ficheros.",
                files: contextFiles,
                activeFile: project.activeFile,
                mode: opts.mode ?? "edit",
              },
              (e) => {
                if (e.type === "text") {
                  retryText += e.text;
                  set({ streamText: retryText });
                } else if (e.type === "done") {
                  model = e.model;
                  usage = e.usage;
                  stopReason = e.stopReason;
                }
              },
              controller.signal,
            );
            retryErr = undefined;
            break;
          } catch (err) {
            retryErr = err;
            if ((err as Error).name === "AbortError") throw err;
            if (!retryText && i < retryAttempts.length - 1) continue;
            throw err;
          }
        }
        if (!retryErr && retryText) {
          const retryParsed = parseFileBlocks(retryText);
          if (Object.keys(retryParsed.updated).length || retryParsed.deleted.length) {
            text += `\n${retryText}`;
            parsed = parseFileBlocks(text);
          }
        }
      } catch {
        /* si el reintento tampoco trae ficheros, se deja el texto como estaba (se avisará más abajo) */
      }
    }

    // Solo se aplican cambios si el proyecto activo sigue siendo el mismo
    const stillSameProject = useStudio.getState().project?.id === project.id;
    const changed = Object.keys(parsed.updated);
    let versionId: string | undefined;
    if (stillSameProject && (changed.length || parsed.deleted.length)) {
      // Repone los datos reales que se omitieron del envío (fuentes/imágenes incrustadas), si el fichero
      // volvió sin tocar esa parte; si la IA sí la cambió, ya no queda el marcador y no se repone nada.
      let toWrite = restoreDataUris(parsed.updated, dataUriRestore);
      // Las imágenes que la IA toma de la captura (captura:…) se recortan y se guardan como ficheros
      let toDelete = parsed.deleted;
      if (hasCaptureRefs(toWrite)) {
        try {
          const crops = await resolveCrops(toWrite, useStudio.getState().project!.files, project.id);
          toWrite = crops.updated;
          toDelete = [...new Set([...toDelete, ...crops.deleted])];
        } catch {
          /* sin recortes: se aplica tal cual */
        }
      }
      let v = await useStudio.getState().applyChanges(toWrite, toDelete, `IA: ${userMsg.content.slice(0, 80)}`, "ai");
      if (!v && !controller.signal.aborted) {
        // El fichero que devolvió la IA es BYTE A BYTE idéntico al que ya había (formato correcto, pero
        // ningún cambio real): sin esto, el chat decía "Aplicados N cambios" aunque la vista previa se
        // quedara exactamente igual. Se le pide una vez que identifique de verdad qué había que cambiar.
        try {
          set({ status: "Ese fichero no cambió nada de verdad: pidiendo que lo corrija otra vez…" });
          const retry2Attempts = buildProviderAttempts(studio, requiredChars);
          const retry2History: ChatTurn[] = [...history, { role: "user", content: userMsg.content }, { role: "assistant", content: text }];
          let retry2Text = "";
          let retry2Err: unknown;
          for (let i = 0; i < retry2Attempts.length; i++) {
            const a = retry2Attempts[i];
            try {
              retry2Text = "";
              await a.run(
                {
                  apiKey: a.apiKey,
                  model: settings.model,
                  effort: settings.effort,
                  history: retry2History,
                  prompt:
                    "El/los fichero(s) que devolviste en tu respuesta anterior son exactamente iguales a los que ya había en el proyecto: no cambiaste nada de verdad, aunque el formato fuera correcto. Vuelve a leer con atención lo que pedí y devuelve el fichero YA modificado de verdad (con una diferencia real respecto al original), en el mismo formato <file path=\"...\">…</file>.",
                  files: contextFiles,
                  activeFile: project.activeFile,
                  mode: opts.mode ?? "edit",
                },
                (e) => {
                  if (e.type === "text") {
                    retry2Text += e.text;
                    set({ streamText: retry2Text });
                  } else if (e.type === "done") {
                    model = e.model;
                    usage = e.usage;
                    stopReason = e.stopReason;
                  }
                },
                controller.signal,
              );
              retry2Err = undefined;
              break;
            } catch (err) {
              retry2Err = err;
              if ((err as Error).name === "AbortError") throw err;
              if (!retry2Text && i < retry2Attempts.length - 1) continue;
              throw err;
            }
          }
          if (!retry2Err && retry2Text) {
            const retry2Parsed = parseFileBlocks(retry2Text);
            if (Object.keys(retry2Parsed.updated).length || retry2Parsed.deleted.length) {
              text += `\n${retry2Text}`;
              parsed = parseFileBlocks(text);
              let toWrite2 = restoreDataUris(parsed.updated, dataUriRestore);
              let toDelete2 = parsed.deleted;
              if (hasCaptureRefs(toWrite2)) {
                try {
                  const crops = await resolveCrops(toWrite2, useStudio.getState().project!.files, project.id);
                  toWrite2 = crops.updated;
                  toDelete2 = [...new Set([...toDelete2, ...crops.deleted])];
                } catch {
                  /* sin recortes: se aplica tal cual */
                }
              }
              v = await useStudio.getState().applyChanges(toWrite2, toDelete2, `IA: ${userMsg.content.slice(0, 80)}`, "ai");
            }
          }
        } catch {
          /* si el reintento tampoco trae un cambio real, se avisa igual que antes (ver más abajo) */
        }
      }
      versionId = v?.id;
    }
    if (parsed.incomplete && !error) {
      error = stopReason === "max_tokens" ? "La respuesta se truncó por longitud; algún fichero no se aplicó." : "Un bloque de fichero quedó incompleto y no se aplicó.";
    } else if (!error && !changed.length && !parsed.deleted.length && parsed.prose.trim().length > 0) {
      // Ni la respuesta original ni el reintento trajeron ficheros: se avisa en vez de dejar un "cambio
      // fantasma" (la IA contesta con texto, pero la vista previa sigue exactamente igual que antes).
      error = "La IA respondió con texto pero no llegó a escribir el código del cambio. Prueba a pedirlo de nuevo, quizá con otras palabras.";
    } else if (!error && (changed.length || parsed.deleted.length) && !versionId) {
      // Se devolvieron ficheros con el formato correcto, pero ni la respuesta original ni el reintento
      // cambiaron nada respecto a lo que ya había: se avisa en vez de decir "Aplicados" sin ser cierto.
      error = "La IA devolvió el fichero sin ningún cambio real. Prueba a describir el cambio de otra forma (indicando el elemento exacto que quieres modificar).";
    }

    const assistantMsg: ChatMessage = {
      id: uid("m_"),
      projectId: project.id,
      role: "assistant",
      content: text || (error ? "" : "(respuesta vacía)"),
      createdAt: Date.now(),
      meta: { model, usage, versionId, changed, deleted: parsed.deleted, error, stopReason },
    };
    await db.saveChatMessage(assistantMsg);
    if (get().projectId === project.id) set({ messages: [...get().messages, assistantMsg] });
    set({ streaming: false, streamText: "", status: "", controller: null });

    const studioNow = useStudio.getState();
    if (error) studioNow.toast(error, "error");
    // Solo se avisa de éxito si de verdad se creó una versión nueva (versionId): con ficheros idénticos a
    // los que ya había, "changed"/"deleted" pueden no estar vacíos aunque no haya cambiado nada de verdad.
    else if (versionId) studioNow.toast(`Aplicados ${changed.length + parsed.deleted.length} cambio(s) de fichero`, "success");
  },
}));
