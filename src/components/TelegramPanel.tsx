import { useEffect, useState } from "react";
import { useStudio } from "../store/studio";
import * as db from "../db/db";
import type { BackupRecord } from "../db/db";
import { backupToTelegram, restoreFromTelegram, telegramReady } from "../lib/backup";
import { formatBytes, timeAgo } from "../lib/util";
import { Icon } from "./Icon";
import { ServerNotice } from "./ServerNotice";

export function TelegramPanel() {
  const settings = useStudio((s) => s.settings);
  const project = useStudio((s) => s.project);
  const projectCount = useStudio((s) => s.projects.length);
  const { toast, setSettingsOpen } = useStudio.getState();
  const [backups, setBackups] = useState<BackupRecord[]>([]);
  const [busy, setBusy] = useState<string>("");
  const [fileId, setFileId] = useState("");

  const refresh = () => void db.listBackups().then(setBackups);
  useEffect(refresh, []);

  const ready = telegramReady();

  const doBackup = async (scope: "project" | "all") => {
    setBusy(scope);
    try {
      const rec = await backupToTelegram(scope, project?.id);
      toast(`Copia enviada a Telegram (${formatBytes(rec.size)})`, "success");
      refresh();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy("");
    }
  };

  const doRestore = async (id: string) => {
    setBusy(`restore:${id}`);
    try {
      const n = await restoreFromTelegram(id);
      toast(`Restaurados ${n} proyecto(s) desde Telegram`, "success");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="tool-body">
      <ServerNotice feature="la sincronización con Telegram" worksServerless />
      <div className="card">
        <div className="row">
          <Icon name="cloud" size={20} />
          <div className="grow">
            <div style={{ fontWeight: 600 }}>Almacenamiento descentralizado</div>
            <div className="small muted">
              {ready ? `Conectado a ${settings.telegramChatTitle || settings.telegramChatId}` : "Bot de Telegram no configurado"}
            </div>
          </div>
          <button className="btn sm" onClick={() => setSettingsOpen(true)}>
            <Icon name="settings" size={12} /> Configurar
          </button>
        </div>
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary grow" style={{ justifyContent: "center" }} disabled={!ready || !!busy} onClick={() => void doBackup("project")}>
          {busy === "project" ? <span className="spinner" /> : <Icon name="upload" />} Respaldar proyecto
        </button>
        <button className="btn grow" style={{ justifyContent: "center" }} disabled={!ready || !!busy || !projectCount} onClick={() => void doBackup("all")}>
          {busy === "all" ? <span className="spinner" /> : <Icon name="package" />} Respaldar todo ({projectCount})
        </button>
      </div>
      <div className="small muted" style={{ marginTop: 6 }}>
        Cada copia es un ZIP con el código, el historial de versiones, las conversaciones y las referencias visuales.
        {settings.autoBackupMinutes > 0 ? ` Copia automática cada ${settings.autoBackupMinutes} min si hay cambios.` : ""}
      </div>

      <div className="section-title">Copias registradas ({backups.length})</div>
      {backups.length === 0 && <div className="empty">Aún no hay copias. Las copias enviadas desde este navegador aparecerán aquí.</div>}
      <div className="list">
        {backups.map((b) => (
          <div key={b.id} className="list-item">
            <Icon name={b.scope === "all" ? "package" : "zip"} />
            <div className="grow">
              <div style={{ fontWeight: 500 }}>{b.projectName}</div>
              <div className="small muted">
                {timeAgo(b.createdAt)} · {formatBytes(b.size)} · mensaje #{b.messageId}
              </div>
            </div>
            <button className="btn sm" disabled={!!busy || !settings.telegramToken} onClick={() => void doRestore(b.fileId)} title="Descargar e importar">
              {busy === `restore:${b.fileId}` ? <span className="spinner" /> : <Icon name="download" size={12} />} Restaurar
            </button>
            <button
              className="btn sm icon ghost"
              aria-label="Olvidar registro"
              title="Olvidar este registro (la copia sigue en Telegram)"
              onClick={() => void db.deleteBackupRecord(b.id).then(refresh)}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        ))}
      </div>

      <div className="section-title">Restaurar por file_id</div>
      <div className="row">
        <input className="input mono" placeholder="BQACAgQAAxkDAAI…" value={fileId} onChange={(e) => setFileId(e.target.value)} aria-label="file_id de Telegram" />
        <button className="btn" disabled={!fileId.trim() || !!busy || !settings.telegramToken} onClick={() => void doRestore(fileId)}>
          Restaurar
        </button>
      </div>
      <div className="small muted" style={{ marginTop: 6 }}>
        Útil en otro equipo: el file_id aparece en el registro de copias del equipo de origen. Solo funciona con el mismo bot. También
        puedes descargar el ZIP desde Telegram e importarlo con el botón «Importar ZIP» de la barra lateral.
      </div>
    </div>
  );
}
