import { useEffect, useState } from "react";
import { useStudio } from "../store/studio";
import { Dialog } from "./Dialog";

/** Confirmación dentro de la página: funciona también donde confirm()/prompt() están bloqueados. */
export function AskDialog() {
  const pending = useStudio((s) => s.pendingAsk);
  const resolveAsk = useStudio((s) => s.resolveAsk);
  const [value, setValue] = useState("");

  useEffect(() => setValue(pending?.input?.defaultValue ?? ""), [pending]);

  const accept = () => resolveAsk(pending?.input ? value : "");

  return (
    <Dialog
      title={pending?.title ?? ""}
      open={!!pending}
      onClose={() => resolveAsk(null)}
      footer={
        <>
          <button className="btn" onClick={() => resolveAsk(null)}>
            Cancelar
          </button>
          <button className={`btn ${pending?.danger ? "danger" : "primary"}`} onClick={accept}>
            {pending?.confirmLabel ?? "Aceptar"}
          </button>
        </>
      }
    >
      {pending?.message && <p style={{ marginTop: 0 }}>{pending.message}</p>}
      {pending?.input && (
        <label className="field" style={{ marginBottom: 0 }}>
          <span>{pending.input.label}</span>
          <input
            id="ask-input"
            className="input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && accept()}
          />
        </label>
      )}
    </Dialog>
  );
}
