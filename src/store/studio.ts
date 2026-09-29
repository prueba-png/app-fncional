import { create } from "zustand";
import type { FileMap } from "../../shared/types";
import { sanitizePath } from "../../shared/fileBlocks";
import * as db from "../db/db";
import type { Project, Settings, Version, VersionSource } from "../db/db";
import { health, type HealthInfo } from "../lib/api";
import { canSaveFiles, getSample, sampleSupportsImages } from "../lib/runtime";
import { TEMPLATES } from "../lib/templates";
import { uid } from "../lib/util";
import type { ProjectBundle } from "../lib/zip";

export type ToolTab = "chat" | "history" | "ingest" | "references" | "dependencies" | "telegram";

export interface AskOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
  /** Si se indica, el diálogo muestra un campo de texto y devuelve su valor */
  input?: { label: string; defaultValue?: string };
}

interface PendingAsk extends AskOptions {
  resolve: (value: string | null) => void;
}

/**
 * De dónde sale la IA:
 * - "server": el servidor local (necesita clave de API de Anthropic);
 * - "direct": versión publicada; el navegador llama a Anthropic con la clave del usuario;
 * - "claude": la cuenta de claude.ai del usuario, cuando la app se abre como página publicada;
 * - "none": ninguna disponible.
 */
export type AiSource = "server" | "direct" | "claude" | "none";

export interface Toast {
  id: string;
  kind: "info" | "success" | "error";
  message: string;
}

interface StudioState {
  ready: boolean;
  settings: Settings;
  health: HealthInfo | null;
  projects: Project[];
  project: Project | null;
  versions: Version[];
  tab: ToolTab;
  toasts: Toast[];
  settingsOpen: boolean;
  newProjectOpen: boolean;
  pendingAsk: PendingAsk | null;
  ai: AiSource;
  /** Solo con ai = "claude": si esta vista puede enviar imágenes (null = aún no se sabe) */
  webImages: boolean | null;
  canDownload: boolean;

  init(): Promise<void>;
  /** Confirmación dentro de la página (sustituye a confirm/prompt). Devuelve null si se cancela. */
  ask(opts: AskOptions): Promise<string | null>;
  resolveAsk(value: string | null): void;
  toast(message: string, kind?: Toast["kind"]): void;
  dismissToast(id: string): void;
  setTab(tab: ToolTab): void;
  setSettingsOpen(open: boolean): void;
  setNewProjectOpen(open: boolean): void;
  updateSettings(patch: Partial<Settings>): Promise<void>;

  createProject(input: {
    name: string;
    files: FileMap;
    origin: Project["origin"];
    ingest?: Project["ingest"];
    message?: string;
    source?: VersionSource;
  }): Promise<Project>;
  openProject(id: string): Promise<void>;
  renameProject(id: string, name: string): Promise<void>;
  duplicateProject(id: string): Promise<void>;
  deleteProject(id: string): Promise<void>;
  setAutoInjectDeps(value: boolean): void;
  patchProject(patch: Partial<Pick<Project, "ingest" | "origin">>): void;

  setActiveFile(path: string): void;
  updateFile(path: string, content: string): void;
  addFile(path: string, content?: string): boolean;
  renameFile(from: string, to: string): boolean;
  deleteFile(path: string): void;

  commit(message: string, source: VersionSource): Promise<Version | null>;
  applyChanges(updated: FileMap, deleted: string[], message: string, source: VersionSource): Promise<Version | null>;
  restoreVersion(versionId: string): Promise<void>;
  refreshVersions(): Promise<void>;

  flush(): Promise<void>;
  getBundle(projectId: string): Promise<ProjectBundle | null>;
  importBundles(bundles: ProjectBundle[], origin: Project["origin"]["type"]): Promise<number>;
}

/** ¿Se puede usar la IA ahora mismo? */
export function aiAvailable(s: Pick<StudioState, "ai" | "settings" | "health">): boolean {
  if (s.ai === "claude") return true;
  if (s.ai === "direct") return Boolean(s.settings.anthropicApiKey);
  return s.ai === "server" && Boolean(s.settings.anthropicApiKey || s.health?.hasEnvApiKey);
}

/** Hay servidor local pero falta la clave de API. */
export function needsApiKey(s: Pick<StudioState, "ai" | "settings" | "health">): boolean {
  if (s.ai === "direct") return !s.settings.anthropicApiKey;
  return s.ai === "server" && !s.settings.anthropicApiKey && !s.health?.hasEnvApiKey;
}

/** Compilación de demostración sin servidor local (VITE_DEMO=1). */
export const IS_DEMO = import.meta.env.VITE_DEMO === "1";

const LAST_PROJECT_KEY = "devstudio:lastProject";
let persistTimer: ReturnType<typeof setTimeout> | undefined;

function sameFiles(a: FileMap, b: FileMap): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => k in b && a[k] === b[k]);
}

export const useStudio = create<StudioState>((set, get) => {
  const schedulePersist = () => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => void get().flush(), 500);
  };

  const mutateProject = (fn: (p: Project) => Project) => {
    const p = get().project;
    if (!p) return;
    const next = { ...fn(p), updatedAt: Date.now() };
    set({ project: next, projects: get().projects.map((x) => (x.id === next.id ? next : x)) });
    schedulePersist();
  };

  return {
    ready: false,
    settings: db.DEFAULT_SETTINGS,
    health: null,
    projects: [],
    project: null,
    versions: [],
    tab: "chat",
    toasts: [],
    settingsOpen: false,
    newProjectOpen: false,
    pendingAsk: null,
    ai: "none",
    webImages: null,
    canDownload: true,

    ask(opts) {
      get().pendingAsk?.resolve(null);
      return new Promise((resolve) => set({ pendingAsk: { ...opts, resolve } }));
    },
    resolveAsk(value) {
      const pending = get().pendingAsk;
      set({ pendingAsk: null });
      pending?.resolve(value);
    },

    async init() {
      const [settings, projects, h] = await Promise.all([db.loadSettings(), db.listProjects(), health()]);
      set({ settings, projects, health: h, ai: h ? (h.llm === false ? "direct" : "server") : "none" });
      if (!h) {
        // Sin servidor local: se prueba la IA y las descargas del visor de claude.ai (no bloquea el arranque)
        void getSample().then(async (s) => {
          if (!s) return;
          set({ ai: "claude" });
          set({ webImages: await sampleSupportsImages(s) });
        });
        void canSaveFiles().then((ok) => set({ canDownload: ok }));
      }
      let last: string | null = null;
      try {
        last = localStorage.getItem(LAST_PROJECT_KEY);
      } catch {
        /* almacenamiento no disponible */
      }
      const target = projects.find((p) => p.id === last) ?? projects[0];
      if (target) await get().openProject(target.id);
      else {
        const tpl = TEMPLATES.find((t) => t.id === "landing")!;
        await get().createProject({ name: "Mi primer prototipo", files: tpl.files, origin: { type: "template", detail: tpl.id } });
      }
      set({ ready: true });
      if (db.memoryOnly) get().toast("El navegador no permite guardar datos: los cambios solo duran mientras la pestaña esté abierta.", "info");
      if (!h && !IS_DEMO) get().toast("No se detecta el servidor local: el análisis de URLs, el asistente y Telegram no estarán disponibles.", "error");
    },

    toast(message, kind = "info") {
      const id = uid("t_");
      set({ toasts: [...get().toasts.filter((t) => t.message !== message).slice(-2), { id, kind, message }] });
      setTimeout(() => get().dismissToast(id), kind === "error" ? 8000 : 4000);
    },
    dismissToast(id) {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    },
    setTab(tab) {
      set({ tab });
    },
    setSettingsOpen(open) {
      set({ settingsOpen: open });
    },
    setNewProjectOpen(open) {
      set({ newProjectOpen: open });
    },
    async updateSettings(patch) {
      set({ settings: { ...get().settings, ...patch } });
      await db.saveSettings(patch);
    },

    async createProject({ name, files, origin, ingest, message, source }) {
      await get().flush();
      const now = Date.now();
      const entry = "index.html" in files ? "index.html" : Object.keys(files)[0] ?? "index.html";
      const project: Project = {
        id: uid("p_"),
        name: name.trim() || "Proyecto sin título",
        files: Object.keys(files).length ? files : { "index.html": "" },
        activeFile: entry,
        createdAt: now,
        updatedAt: now,
        origin,
        ingest,
        autoInjectDeps: true,
      };
      await db.saveProject(project);
      await db.addVersion({
        id: uid("v_"),
        projectId: project.id,
        createdAt: now,
        message: message ?? "Creación del proyecto",
        source: source ?? "create",
        files: project.files,
      });
      set({ projects: [project, ...get().projects] });
      await get().openProject(project.id);
      return project;
    },

    async openProject(id) {
      await get().flush();
      const project = (await db.getProject(id)) ?? null;
      if (!project) return;
      set({ project, versions: await db.listVersions(id) });
      try {
        localStorage.setItem(LAST_PROJECT_KEY, id);
      } catch {
        /* sin almacenamiento */
      }
    },

    async renameProject(id, name) {
      const clean = name.trim();
      if (!clean) return;
      if (get().project?.id === id) {
        mutateProject((p) => ({ ...p, name: clean }));
        return;
      }
      const p = await db.getProject(id);
      if (!p) return;
      const next = { ...p, name: clean, updatedAt: Date.now() };
      await db.saveProject(next);
      set({ projects: get().projects.map((x) => (x.id === id ? next : x)) });
    },

    async duplicateProject(id) {
      await get().flush();
      const p = await db.getProject(id);
      if (!p) return;
      await get().createProject({
        name: `${p.name} (copia)`,
        files: { ...p.files },
        origin: p.origin,
        ingest: p.ingest,
        message: `Duplicado de "${p.name}"`,
      });
      get().toast("Proyecto duplicado", "success");
    },

    async deleteProject(id) {
      clearTimeout(persistTimer);
      await db.deleteProjectCascade(id);
      const projects = get().projects.filter((p) => p.id !== id);
      set({ projects });
      if (get().project?.id === id) {
        set({ project: null, versions: [] });
        if (projects[0]) await get().openProject(projects[0].id);
        else {
          const tpl = TEMPLATES[0];
          await get().createProject({ name: "Nuevo proyecto", files: tpl.files, origin: { type: "template", detail: tpl.id } });
        }
      }
    },

    setAutoInjectDeps(value) {
      mutateProject((p) => ({ ...p, autoInjectDeps: value }));
    },

    patchProject(patch) {
      mutateProject((p) => ({ ...p, ...patch }));
    },

    setActiveFile(path) {
      mutateProject((p) => ({ ...p, activeFile: path }));
    },

    updateFile(path, content) {
      mutateProject((p) => (p.files[path] === content ? p : { ...p, files: { ...p.files, [path]: content } }));
    },

    addFile(path, content = "") {
      const clean = sanitizePath(path);
      const p = get().project;
      if (!clean || !p) {
        get().toast("Ruta de fichero no válida.", "error");
        return false;
      }
      if (clean in p.files) {
        get().toast(`Ya existe "${clean}".`, "error");
        return false;
      }
      mutateProject((pr) => ({ ...pr, files: { ...pr.files, [clean]: content }, activeFile: clean }));
      return true;
    },

    renameFile(from, to) {
      const clean = sanitizePath(to);
      const p = get().project;
      if (!clean || !p || !(from in p.files)) {
        get().toast("Ruta de fichero no válida.", "error");
        return false;
      }
      if (clean === from) return true;
      if (clean in p.files) {
        get().toast(`Ya existe "${clean}".`, "error");
        return false;
      }
      mutateProject((pr) => {
        const files: FileMap = {};
        for (const [k, v] of Object.entries(pr.files)) files[k === from ? clean : k] = v;
        return { ...pr, files, activeFile: pr.activeFile === from ? clean : pr.activeFile };
      });
      return true;
    },

    deleteFile(path) {
      mutateProject((pr) => {
        const files = { ...pr.files };
        delete files[path];
        const keys = Object.keys(files);
        return { ...pr, files, activeFile: pr.activeFile === path ? (keys[0] ?? "") : pr.activeFile };
      });
    },

    async commit(message, source) {
      const p = get().project;
      if (!p) return null;
      await get().flush();
      const latest = get().versions[0];
      if (latest && sameFiles(latest.files, p.files)) return null;
      const v: Version = { id: uid("v_"), projectId: p.id, createdAt: Date.now(), message, source, files: { ...p.files } };
      await db.addVersion(v);
      await get().refreshVersions();
      return v;
    },

    async applyChanges(updated, deleted, message, source) {
      const p = get().project;
      if (!p) return null;
      // Se guarda el estado previo si tenía cambios sin versionar, para poder volver a él.
      await get().commit("Cambios manuales (antes de aplicar)", "manual");
      mutateProject((pr) => {
        const files = { ...pr.files, ...updated };
        for (const d of deleted) delete files[d];
        const active = pr.activeFile in files ? pr.activeFile : (Object.keys(updated)[0] ?? Object.keys(files)[0] ?? "");
        return { ...pr, files, activeFile: active };
      });
      return get().commit(message, source);
    },

    async restoreVersion(versionId) {
      const v = get().versions.find((x) => x.id === versionId);
      const p = get().project;
      if (!v || !p) return;
      await get().commit("Cambios manuales (antes del rollback)", "manual");
      mutateProject((pr) => ({
        ...pr,
        files: { ...v.files },
        activeFile: pr.activeFile in v.files ? pr.activeFile : (Object.keys(v.files)[0] ?? ""),
      }));
      const created = await get().commit(`Rollback a «${v.message}» (${new Date(v.createdAt).toLocaleString("es")})`, "rollback");
      get().toast(created ? "Versión restaurada" : "El proyecto ya estaba en esa versión", "success");
    },

    async refreshVersions() {
      const p = get().project;
      if (p) set({ versions: await db.listVersions(p.id) });
    },

    async flush() {
      clearTimeout(persistTimer);
      const p = get().project;
      if (p) await db.saveProject(p);
    },

    async getBundle(projectId) {
      await get().flush();
      const project = await db.getProject(projectId);
      if (!project) return null;
      const [versions, chat, references] = await Promise.all([
        db.listVersions(projectId),
        db.listChat(projectId),
        db.listReferences(projectId),
      ]);
      return { project, versions, chat, references };
    },

    async importBundles(bundles, originType) {
      let count = 0;
      const existing = new Set(get().projects.map((p) => p.id));
      for (const b of bundles) {
        const collides = !b.project.id || existing.has(b.project.id);
        const id = collides ? uid("p_") : b.project.id;
        const now = Date.now();
        const project: Project = {
          ...b.project,
          id,
          name: collides && b.project.id ? `${b.project.name} (restaurado)` : b.project.name,
          updatedAt: now,
          origin: b.project.origin?.type ? b.project.origin : { type: originType },
          autoInjectDeps: b.project.autoInjectDeps ?? true,
        };
        await db.saveProject(project);
        const versions = b.versions.length
          ? b.versions
          : [{ id: "", projectId: id, createdAt: now, message: "Importación", source: "restore" as const, files: project.files }];
        for (const v of versions) await db.addVersion({ ...v, id: collides || !v.id ? uid("v_") : v.id, projectId: id });
        for (const m of b.chat) await db.saveChatMessage({ ...m, id: collides ? uid("m_") : m.id, projectId: id });
        for (const r of b.references) await db.saveReference({ ...r, id: collides ? uid("ref_") : r.id, projectId: id });
        existing.add(id);
        count++;
        if (count === bundles.length) {
          set({ projects: await db.listProjects() });
          await get().openProject(id);
        }
      }
      return count;
    },
  };
});

/** Guarda los cambios pendientes antes de cerrar la pestaña. */
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => void useStudio.getState().flush());
}
