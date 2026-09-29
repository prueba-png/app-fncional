import { useStudio } from "../store/studio";
import { Icon } from "./Icon";

export function Toasts() {
  const toasts = useStudio((s) => s.toasts);
  const dismiss = useStudio((s) => s.dismissToast);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <Icon name={t.kind === "error" ? "x" : t.kind === "success" ? "check" : "bolt"} />
          <div className="grow">{t.message}</div>
          <button className="btn sm icon ghost" onClick={() => dismiss(t.id)} aria-label="Cerrar aviso">
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
