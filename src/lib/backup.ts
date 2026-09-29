/**
 * Sincronización con Telegram: empaqueta proyectos (código + historial +
 * conversaciones + referencias) y los envía al chat configurado.
 */
import * as db from "../db/db";
import { useStudio } from "../store/studio";
import { telegramBackup, telegramRestore } from "./api";
import { blobToBase64, formatBytes, slugify, uid } from "./util";
import { createBackupBundle, readZip, type ProjectBundle } from "./zip";

export function telegramReady(): boolean {
  const { telegramToken, telegramChatId } = useStudio.getState().settings;
  return Boolean(telegramToken && telegramChatId);
}

export async function backupToTelegram(scope: "project" | "all", projectId?: string): Promise<db.BackupRecord> {
  const studio = useStudio.getState();
  const { telegramToken: token, telegramChatId: chatId } = studio.settings;
  if (!token || !chatId) throw new Error("Configura el bot de Telegram en Ajustes.");

  const ids = scope === "all" ? studio.projects.map((p) => p.id) : [projectId ?? studio.project?.id].filter(Boolean) as string[];
  if (!ids.length) throw new Error("No hay proyectos que respaldar.");
  const bundles: ProjectBundle[] = [];
  for (const id of ids) {
    const b = await studio.getBundle(id);
    if (b) bundles.push(b);
  }
  const blob = await createBackupBundle(bundles);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const name = scope === "all" ? "todos" : slugify(bundles[0].project.name);
  const filename = `devstudio_${name}_${stamp}.zip`;
  const fileCount = bundles.reduce((n, b) => n + Object.keys(b.project.files).length, 0);
  const caption = [
    "#devstudio_backup",
    scope === "all" ? `📦 ${bundles.length} proyectos` : `📁 ${bundles[0].project.name}`,
    `🗂 ${fileCount} ficheros · ${bundles.reduce((n, b) => n + b.versions.length, 0)} versiones`,
    `💾 ${formatBytes(blob.size)} · ${new Date().toLocaleString("es")}`,
  ].join("\n");

  const res = await telegramBackup({ token, chatId }, filename, caption, await blobToBase64(blob));
  const record: db.BackupRecord = {
    id: uid("b_"),
    scope,
    projectId: scope === "project" ? ids[0] : undefined,
    projectName: scope === "all" ? `${bundles.length} proyectos` : bundles[0].project.name,
    fileId: res.fileId,
    messageId: res.messageId,
    chatTitle: res.chatTitle,
    size: res.fileSize,
    createdAt: Date.now(),
    projectCount: bundles.length,
  };
  await db.saveBackup(record);
  return record;
}

export async function restoreFromTelegram(fileId: string): Promise<number> {
  const studio = useStudio.getState();
  const token = studio.settings.telegramToken;
  if (!token) throw new Error("Configura el bot de Telegram en Ajustes.");
  const blob = await telegramRestore(token, fileId.trim());
  const { bundles } = await readZip(blob, "Restaurado de Telegram");
  return studio.importBundles(bundles, "telegram");
}
