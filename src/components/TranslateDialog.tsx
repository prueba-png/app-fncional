import { useState } from "react";
import { useChat } from "../store/chat";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";

const LANGUAGES = [
  "Español",
  "Inglés",
  "Francés",
  "Alemán",
  "Italiano",
  "Portugués",
  "Catalán",
  "Euskera",
  "Gallego",
  "Árabe",
  "Chino (mandarín)",
  "Japonés",
  "Coreano",
  "Ruso",
];

/** Instrucción para traducir todos los textos visibles del proyecto, sin tocar el código ni el diseño. */
function translatePrompt(language: string): string {
  return `Traduce al ${language} TODOS los textos visibles del proyecto: títulos, párrafos, botones, menús, formularios (etiquetas y placeholders), mensajes y atributos alt/aria-label/title/placeholder.
- No traduzcas nombres propios de marca, código, nombres de variables, clases CSS, IDs ni comentarios de código.
- No cambies el diseño, la estructura HTML, los estilos ni el comportamiento: solo el texto.
- Actualiza el atributo lang de la etiqueta <html> al idioma correspondiente (por ejemplo lang="es", lang="en", lang="fr"…).
- Si algún texto ya está en ${language}, déjalo igual.
- Devuelve completos únicamente los ficheros que contengan texto a traducir.`;
}

export function TranslateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const streaming = useChat((s) => s.streaming);
  const [language, setLanguage] = useState(LANGUAGES[1]);
  const [custom, setCustom] = useState("");

  const go = async () => {
    const target = (custom.trim() || language).trim();
    if (!target) return;
    onClose();
    await useChat.getState().send(translatePrompt(target));
  };

  return (
    <Dialog
      title="Traducir la página"
      open={open}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" onClick={() => void go()} disabled={streaming || (!custom.trim() && !language)}>
            <Icon name="translate" /> Traducir
          </button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        La IA traduce todos los textos que se ven (títulos, botones, menús, formularios…) sin tocar el diseño ni el código. Crea una nueva
        versión, así que puedes deshacerlo si no te convence.
      </p>
      <label className="field">
        <span>Idioma</span>
        <select
          className="select"
          value={language}
          onChange={(e) => {
            setLanguage(e.target.value);
            setCustom("");
          }}
        >
          {LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>O escribe otro idioma</span>
        <input
          className="input"
          placeholder="Por ejemplo: neerlandés, sueco, turco…"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void go()}
        />
      </label>
    </Dialog>
  );
}
