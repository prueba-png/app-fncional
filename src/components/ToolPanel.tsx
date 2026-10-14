import { useStudio, type ToolTab } from "../store/studio";
import { Icon, type IconName } from "./Icon";
import { ChatPanel } from "./ChatPanel";
import { HistoryPanel } from "./HistoryPanel";
import { IngestPanel } from "./IngestPanel";
import { ReferencePanel } from "./ReferencePanel";
import { DependencyPanel } from "./DependencyPanel";
import { TelegramPanel } from "./TelegramPanel";

const TABS: Array<{ id: ToolTab; label: string; icon: IconName }> = [
  { id: "chat", label: "Asistente", icon: "chat" },
  { id: "history", label: "Historial", icon: "history" },
  { id: "ingest", label: "Análisis", icon: "globe" },
  { id: "references", label: "Visual", icon: "image" },
  { id: "dependencies", label: "Librerías", icon: "package" },
  { id: "telegram", label: "Telegram", icon: "cloud" },
];

export function ToolPanel() {
  const tab = useStudio((s) => s.tab);
  const setTab = useStudio((s) => s.setTab);
  return (
    <aside className="tools" aria-label="Herramientas">
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab${tab === t.id ? " active" : ""}`} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} size={16} />
            {t.label}
          </button>
        ))}
      </div>
      {tab === "chat" && <ChatPanel />}
      {tab === "history" && <HistoryPanel />}
      {tab === "ingest" && <IngestPanel />}
      {tab === "references" && <ReferencePanel />}
      {tab === "dependencies" && <DependencyPanel />}
      {tab === "telegram" && <TelegramPanel />}
    </aside>
  );
}
