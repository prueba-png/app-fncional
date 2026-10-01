import { useRef, useState } from "react";
import { useStudio } from "../store/studio";
import { Icon } from "./Icon";

/** API mínima de SpeechRecognition / webkitSpeechRecognition (no está en los tipos de TS por defecto). */
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

const ERROR_MESSAGES: Record<string, string> = {
  "not-allowed": "El navegador no tiene permiso para usar el micrófono. Revisa los permisos del sitio.",
  "service-not-allowed": "El navegador no tiene permiso para usar el micrófono. Revisa los permisos del sitio.",
  "audio-capture": "No se encuentra ningún micrófono en este dispositivo.",
  network: "No se pudo conectar con el servicio de voz (hace falta conexión a internet).",
};

function getRecognition(): SpeechRecognitionLike | null {
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

export const speechSupported =
  typeof window !== "undefined" && !!((window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition);

/**
 * Botón de micrófono para dictar por voz en vez de escribir. Añade el texto reconocido a lo que ya
 * hubiera (no lo sustituye), para poder dictar varias veces seguidas. Se oculta solo si el navegador
 * no soporta reconocimiento de voz (algunos navegadores de escritorio distintos de Chrome).
 */
export function MicButton({ onText, disabled, big }: { onText: (text: string) => void; disabled?: boolean; big?: boolean }) {
  const [listening, setListening] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);

  if (!speechSupported) return null;

  const stop = () => {
    recRef.current?.stop();
    recRef.current = null;
    setListening(false);
  };

  const toggle = () => {
    if (listening) {
      stop();
      return;
    }
    const rec = getRecognition();
    if (!rec) return;
    rec.lang = "es-ES";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      const text = Array.from(e.results)
        .map((r) => r[0]?.transcript ?? "")
        .join(" ")
        .trim();
      if (text) onText(text);
    };
    rec.onerror = (e) => {
      recRef.current = null;
      setListening(false);
      // "no-speech" o "aborted" no son errores reales (el usuario no dijo nada o detuvo el dictado): no hace falta avisar
      if (e.error && e.error !== "no-speech" && e.error !== "aborted") useStudio.getState().toast(ERROR_MESSAGES[e.error] ?? "No se pudo usar el micrófono.", "error");
    };
    rec.onend = () => {
      recRef.current = null;
      setListening(false);
    };
    recRef.current = rec;
    rec.start();
    setListening(true);
  };

  return (
    <button
      type="button"
      className={`btn icon${big ? " big" : ""}${listening ? " mic-on" : ""}`}
      aria-label={listening ? "Detener dictado por voz" : "Hablar en vez de escribir"}
      title={listening ? "Detener dictado" : "Hablar en vez de escribir"}
      onClick={toggle}
      disabled={disabled}
    >
      <Icon name="mic" />
    </button>
  );
}
