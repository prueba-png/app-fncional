/**
 * Persistencia local estructurada (IndexedDB) de proyectos, historial de
 * versiones, conversaciones, referencias visuales, copias de seguridad y ajustes.
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import * as fakeIDB from "fake-indexeddb";
import type { FileMap, IngestResult } from "../../shared/types";

export type IngestReport = Omit<IngestResult, "files">;

export interface Project {
  id: string;
  name: string;
  files: FileMap;
  activeFile: string;
  createdAt: number;
  updatedAt: number;
  origin: { type: "blank" | "template" | "url" | "reference" | "import" | "telegram"; detail?: string };
  ingest?: IngestReport;
  autoInjectDeps: boolean;
}

export type VersionSource = "create" | "manual" | "ai" | "ingest" | "rollback" | "dependency" | "restore";

export interface Version {
  id: string;
  projectId: string;
  createdAt: number;
  message: string;
  source: VersionSource;
  files: FileMap;
}

export interface ChatMessage {
  id: string;
  projectId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  meta?: {
    model?: string;
    usage?: { input: number; output: number };
    versionId?: string;
    changed?: string[];
    deleted?: string[];
    error?: string;
    attachments?: string[];
    stopReason?: string | null;
  };
}

export interface VisualReference {
  id: string;
  projectId: string;
  name: string;
  kind: "image" | "video" | "pdf" | "svg";
  size: number;
  createdAt: number;
  /** Imágenes optimizadas (data URL) listas para enviar al modelo */
  frames: string[];
  /** Solo PDF: data URL del documento */
  pdf?: string;
  /** Solo SVG: marcado original */
  svgText?: string;
  palette: string[];
  width?: number;
  height?: number;
  duration?: number;
}

export interface BackupRecord {
  id: string;
  scope: "project" | "all";
  projectId?: string;
  projectName: string;
  fileId: string;
  messageId: number;
  chatTitle?: string;
  size: number;
  createdAt: number;
  projectCount: number;
}

export interface Settings {
  anthropicApiKey: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  telegramToken: string;
  telegramChatId: string;
  telegramChatTitle: string;
  autoBackupMinutes: number;
}

export const DEFAULT_SETTINGS: Settings = {
  anthropicApiKey: "",
  model: "claude-opus-5-5",
  // «medium» es el valor recomendado para Claude Opus 5.5: clones bastante más rápidos con buena calidad
  effort: "medium",
  telegramToken: "",
  telegramChatId: "",
  telegramChatTitle: "",
  autoBackupMinutes: 0,
};

interface StudioDB extends DBSchema {
  projects: { key: string; value: Project; indexes: { byUpdated: number } };
  versions: { key: string; value: Version; indexes: { byProject: string } };
  chats: { key: string; value: ChatMessage; indexes: { byProject: string } };
  references: { key: string; value: VisualReference; indexes: { byProject: string } };
  backups: { key: string; value: BackupRecord; indexes: { byCreated: number } };
  settings: { key: string; value: { key: string; value: unknown } };
}

let dbPromise: Promise<IDBPDatabase<StudioDB>> | null = null;

/** true si IndexedDB no está disponible y los datos solo viven en memoria durante la sesión. */
export let memoryOnly = false;

function open() {
  return openDB<StudioDB>("devstudio-pro", 1, {
    upgrade(db) {
      db.createObjectStore("projects", { keyPath: "id" }).createIndex("byUpdated", "updatedAt");
      db.createObjectStore("versions", { keyPath: "id" }).createIndex("byProject", "projectId");
      db.createObjectStore("chats", { keyPath: "id" }).createIndex("byProject", "projectId");
      db.createObjectStore("references", { keyPath: "id" }).createIndex("byProject", "projectId");
      db.createObjectStore("backups", { keyPath: "id" }).createIndex("byCreated", "createdAt");
      db.createObjectStore("settings", { keyPath: "key" });
    },
  });
}

async function openWithFallback() {
  try {
    if (typeof indexedDB === "undefined") throw new Error("IndexedDB no disponible");
    return await Promise.race([
      open(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("IndexedDB no responde")), 4000)),
    ]);
  } catch {
    // Navegación privada, almacenamiento bloqueado o entornos incrustados: se usa una implementación en memoria.
    for (const [name, value] of Object.entries(fakeIDB)) {
      if (name === "default") continue;
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: false });
    }
    memoryOnly = true;
    return open();
  }
}

export function getDB() {
  dbPromise ??= openWithFallback();
  return dbPromise;
}

// ── Proyectos ──────────────────────────────────────────────────────────────
export async function listProjects(): Promise<Project[]> {
  const all = await (await getDB()).getAll("projects");
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function getProject(id: string) {
  return (await getDB()).get("projects", id);
}
export async function saveProject(p: Project) {
  await (await getDB()).put("projects", p);
}
export async function deleteProjectCascade(id: string) {
  const db = await getDB();
  const tx = db.transaction(["projects", "versions", "chats", "references"], "readwrite");
  await tx.objectStore("projects").delete(id);
  for (const store of ["versions", "chats", "references"] as const) {
    const idx = tx.objectStore(store).index("byProject");
    for (let cur = await idx.openCursor(IDBKeyRange.only(id)); cur; cur = await cur.continue()) await cur.delete();
  }
  await tx.done;
}

// ── Versiones ──────────────────────────────────────────────────────────────
export const MAX_VERSIONS_PER_PROJECT = 200;

export async function listVersions(projectId: string): Promise<Version[]> {
  const all = await (await getDB()).getAllFromIndex("versions", "byProject", projectId);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}
export async function addVersion(v: Version) {
  const db = await getDB();
  await db.put("versions", v);
  // Poda: conserva las N versiones más recientes
  const all = await listVersions(v.projectId);
  if (all.length > MAX_VERSIONS_PER_PROJECT) {
    const tx = db.transaction("versions", "readwrite");
    for (const old of all.slice(MAX_VERSIONS_PER_PROJECT)) await tx.store.delete(old.id);
    await tx.done;
  }
}

// ── Chat ───────────────────────────────────────────────────────────────────
export async function listChat(projectId: string): Promise<ChatMessage[]> {
  const all = await (await getDB()).getAllFromIndex("chats", "byProject", projectId);
  return all.sort((a, b) => a.createdAt - b.createdAt);
}
export async function saveChatMessage(m: ChatMessage) {
  await (await getDB()).put("chats", m);
}
export async function clearChat(projectId: string) {
  const db = await getDB();
  const tx = db.transaction("chats", "readwrite");
  for (let cur = await tx.store.index("byProject").openCursor(IDBKeyRange.only(projectId)); cur; cur = await cur.continue())
    await cur.delete();
  await tx.done;
}

// ── Referencias visuales ───────────────────────────────────────────────────
export async function listReferences(projectId: string): Promise<VisualReference[]> {
  const all = await (await getDB()).getAllFromIndex("references", "byProject", projectId);
  return all.sort((a, b) => a.createdAt - b.createdAt);
}
export async function saveReference(r: VisualReference) {
  await (await getDB()).put("references", r);
}
export async function deleteReference(id: string) {
  await (await getDB()).delete("references", id);
}

// ── Copias de seguridad ────────────────────────────────────────────────────
export async function listBackups(): Promise<BackupRecord[]> {
  const all = await (await getDB()).getAll("backups");
  return all.sort((a, b) => b.createdAt - a.createdAt);
}
export async function saveBackup(b: BackupRecord) {
  await (await getDB()).put("backups", b);
}
export async function deleteBackupRecord(id: string) {
  await (await getDB()).delete("backups", id);
}

// ── Ajustes ────────────────────────────────────────────────────────────────
/** Claves secretas: en alojamientos con origen compartido no se guardan de forma permanente. */
const SECRET_KEYS = new Set<keyof Settings>(["anthropicApiKey", "telegramToken"]);
const SHARED_ORIGIN_HOSTS = ["raw.githack.com", "rawcdn.githack.com", "cdn.statically.io", "htmlpreview.github.io"];

/**
 * ¿Comparte la página su origen con webs de otras personas? (p. ej. githack sirve todos los
 * repositorios desde el mismo dominio, así que su almacenamiento es común a todos ellos).
 */
export function isSharedOrigin(): boolean {
  return typeof location !== "undefined" && SHARED_ORIGIN_HOSTS.includes(location.hostname);
}

function sessionGet(key: string): string | null {
  try {
    return sessionStorage.getItem(`devstudio:${key}`);
  } catch {
    return null;
  }
}
function sessionSet(key: string, value: string) {
  try {
    sessionStorage.setItem(`devstudio:${key}`, value);
  } catch {
    /* sin almacenamiento de sesión */
  }
}

/** Copia de seguridad de las claves en localStorage (solo en orígenes propios): si el navegador
 * vacía IndexedDB o no lo permite, la clave sigue ahí y no hay que volver a pegarla. */
function backupGet(key: string): string | null {
  try {
    return localStorage.getItem(`devstudio:keep:${key}`);
  } catch {
    return null;
  }
}
function backupSet(key: string, value: string) {
  try {
    if (value) localStorage.setItem(`devstudio:keep:${key}`, value);
    else localStorage.removeItem(`devstudio:keep:${key}`);
  } catch {
    /* sin almacenamiento local */
  }
}

/** Pide al navegador que no borre los datos de la app para liberar espacio. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    return (await navigator.storage.persisted()) || (await navigator.storage.persist());
  } catch {
    return false;
  }
}

export async function loadSettings(): Promise<Settings> {
  const rows = await (await getDB()).getAll("settings");
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  const shared = isSharedOrigin();
  for (const r of rows) if (r.key in DEFAULT_SETTINGS && !(shared && SECRET_KEYS.has(r.key as keyof Settings))) out[r.key] = r.value;
  for (const k of SECRET_KEYS) {
    if (shared) out[k] = sessionGet(k) ?? "";
    else if (!out[k]) out[k] = backupGet(k) ?? "";
  }
  return out as unknown as Settings;
}
export async function saveSettings(s: Partial<Settings>) {
  const shared = isSharedOrigin();
  const db = await getDB();
  const tx = db.transaction("settings", "readwrite");
  for (const [key, value] of Object.entries(s)) {
    if (shared && SECRET_KEYS.has(key as keyof Settings)) {
      sessionSet(key, String(value ?? ""));
      await tx.store.delete(key); // por si quedó guardada antes
    } else {
      await tx.store.put({ key, value });
      if (SECRET_KEYS.has(key as keyof Settings)) backupSet(key, String(value ?? ""));
    }
  }
  await tx.done;
}
