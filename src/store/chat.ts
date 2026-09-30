import { create } from "zustand";
import type { ChatAttachment, ChatTurn } from "../../shared/types";
import { parseFileBlocks } from "../../shared/fileBlocks";
import * as db from "../db/db";
import type { ChatMessage } from "../db/db";
import { streamChat } from "../lib/api";
import { getSample, sampleChat } from "../lib/runtime";
import { streamDirect } from "../lib/directAi";
import { uid } from "../lib/util";
import { useStudio } from "./studio";

const HISTORY_TURNS = 12;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const rank = (e: string) => EFFORTS.indexOf(e as (typeof EFFORTS)[number]);

interface SendOptions {
  attachments?: ChatAttachment[];
  attachmentLabels?: string[];
  mode?: "edit" | "generate-from-reference";
  webFetch?: boolean;
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
    if (!useWeb && !settings.anthropicApiKey && !studio.health?.hasEnvApiKey) {
      studio.toast("Configura tu clave de API de Anthropic en Ajustes.", "error");
      studio.setSettingsOpen(true);
      return;
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
            attachments: opts.attachments,
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
      } else await (studio.ai === "direct" ? streamDirect : streamChat)(
        {
          apiKey: settings.anthropicApiKey || undefined,
          model: settings.model,
          effort: opts.effort && rank(opts.effort) > rank(settings.effort) ? opts.effort : settings.effort,
          history,
          prompt: userMsg.content,
          files: useStudio.getState().project!.files,
          activeFile: project.activeFile,
          attachments: opts.attachments,
          mode: opts.mode ?? "edit",
          webFetch: opts.webFetch,
        },
        (e) => {
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
        },
        controller.signal,
      );
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
      const v = await useStudio
        .getState()
        .applyChanges(parsed.updated, parsed.deleted, `IA: ${userMsg.content.slice(0, 80)}`, "ai");
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
