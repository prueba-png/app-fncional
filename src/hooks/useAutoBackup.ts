import { useEffect } from "react";
import { useStudio } from "../store/studio";
import { backupToTelegram, telegramReady } from "../lib/backup";
import { listBackups } from "../db/db";

/**
 * Copia de seguridad periódica en Telegram del proyecto activo, solo cuando
 * ha cambiado desde su último respaldo.
 */
export function useAutoBackup() {
  const minutes = useStudio((s) => s.settings.autoBackupMinutes);
  const token = useStudio((s) => s.settings.telegramToken);
  const chatId = useStudio((s) => s.settings.telegramChatId);

  useEffect(() => {
    if (!minutes || minutes <= 0 || !token || !chatId) return;
    let running = false;
    const tick = async () => {
      const { project, toast } = useStudio.getState();
      if (running || !project || !telegramReady()) return;
      const last = (await listBackups()).find((b) => b.scope === "project" && b.projectId === project.id);
      if (last && last.createdAt >= project.updatedAt) return;
      running = true;
      try {
        await backupToTelegram("project", project.id);
        toast(`Copia automática de «${project.name}» enviada a Telegram`, "success");
      } catch (err) {
        toast(`Copia automática fallida: ${(err as Error).message}`, "error");
      } finally {
        running = false;
      }
    };
    const id = setInterval(() => void tick(), minutes * 60_000);
    return () => clearInterval(id);
  }, [minutes, token, chatId]);
}
