import { create } from "zustand";
import { hasCaptureRefs, resolveCrops } from "../lib/crops";
import { memoryAttachments, refersToOriginal } from "../lib/references";
import type { ChatAttachment, ChatTurn } from "../../shared/types";
import { parseFileBlocks } from "../../shared/fileBlocks";
import * as db from "../db/db";
import type { ChatMessage } from "../db/db";
import { streamChat } from "../lib/api";
import { getSample, sampleChat } from "../lib/runtime";
import { streamDirect } from "../lib/directAi";
import { streamGemini, streamOpenRouter } from "../lib/freeAi";
import { uid } from "../lib/util";
import { aiAvailable, useStudio } from "./studio";

const HISTORY_TURNS = 12;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const rank = (e: string) => EFFORTS.indexOf(e as (typeof EFFORTS)[number]);

type StreamFn = (req: import("../../shared/types").ChatRequest, onEvent: (e: import("../../shared/types").ChatStreamEvent) => void, signal: AbortSignal) => Promise<void>;
interface ProviderAttempt {
  label: string;
  apiKey?: string;
  run: StreamFn;
}

/**
 * Lista ordenada de IA a probar: primero la elegida, después las demás que tengan clave.
 * Así, si una agota su cupo gratuito, la app usa otra sin que el usuario tenga que tocar nada.
 */
function buildProviderAttempts(studio: ReturnType<typeof useStudio.getState>): ProviderAttempt[] {
  const s = studio.settings;
  const order: db.AiProvider[] = [s.aiProvider, ...(["gemini", "openrouter", "anthropic"] as db.AiProvider[]).filter((p) => p !== s.aiProvider)];
  const out: ProviderAttempt[] = [];
  for (const p of order) {
    if (p === "gemini" && s.geminiApiKey) out.push({ label: "Google Gemini", apiKey: s.geminiApiKey, run: streamGemini });
    else if (p === "openrouter" && s.openrouterApiKey) out.push({ label: "OpenRouter", apiKey: s.openrouterApiKey, run: streamOpenRouter });
    else if (p === "anthropic" && (s.anthropicApiKey || studio.health?.hasEnvApiKey))
      out.push({ label: "Anthropic", apiKey: s.anthropicApiKey || undefined, run: studio.ai === "direct" ? streamDirect : streamChat });
  }
  return out;
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
            files: useStudio.getState().project!.files,
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
        // Se prueban las IA disponibles en orden; si una agota su cupo gratuito, salta sola a la siguiente
        const attempts = buildProviderAttempts(studio);
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
                files: useStudio.getState().project!.files,
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
            // Se salta al siguiente servicio con clave cuando se agotó el cupo, o cuando la red falló sin
            // llegar a escribir nada (así no se pierde ni se duplica lo que ya se hubiera generado)
            if ((name === "QuotaError" || name === "NetworkError") && !text && i < attempts.length - 1) {
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

    // Solo se aplican cambios si el proyecto activo sigue siendo el mismo
    const parsed = parseFileBlocks(text);
    const stillSameProject = useStudio.getState().project?.id === project.id;
    const changed = Object.keys(parsed.updated);
    let versionId: string | undefined;
    if (stillSameProject && (changed.length || parsed.deleted.length)) {
      // Las imágenes que la IA toma de la captura (captura:…) se recortan y se guardan como ficheros
      let toWrite = parsed.updated;
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
      const v = await useStudio.getState().applyChanges(toWrite, toDelete, `IA: ${userMsg.content.slice(0, 80)}`, "ai");
      versionId = v?.id;
    }
    if (parsed.incomplete && !error) {
      error = stopReason === "max_tokens" ? "La respuesta se truncó por longitud; algún fichero no se aplicó." : "Un bloque de fichero quedó incompleto y no se aplicó.";
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
    else if (changed.length || parsed.deleted.length)
      studioNow.toast(`Aplicados ${changed.length + parsed.deleted.length} cambio(s) de fichero`, "success");
  },
}));
