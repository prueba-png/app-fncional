import { useRef, useState } from "react";
import { useStudio } from "../store/studio";
import { transcribeAudio } from "../lib/freeAi";
import { splitApiKeys } from "../lib/util";
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

/** Safari (iPhone/iPad) no trae `SpeechRecognition`, pero sí graba audio: ahí se usa esto como alternativa. */
export const mediaRecorderSupported = typeof window !== "undefined" && typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * Botón de micrófono para dictar por voz en vez de escribir. Añade el texto reconocido a lo que ya
 * hubiera (no lo sustituye), para poder dictar varias veces seguidas.
 * - Donde el navegador trae reconocimiento de voz (Chrome, Edge…), lo usa directamente, gratis y sin IA.
 * - En Safari (iPhone/iPad), que no lo trae, graba el audio y lo transcribe con la clave gratuita de
 *   Google guardada en Ajustes (la misma que para generar páginas, aunque se use otra IA como principal).
 * Se oculta solo si el navegador no soporta ninguna de las dos formas.
 */
export function MicButton({ onText, disabled, big }: { onText: (text: string) => void; disabled?: boolean; big?: boolean }) {
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  if (!speechSupported && !mediaRecorderSupported) return null;

  const stopRecorder = () => {
    recorderRef.current?.stop();
  };

  const toggle = () => {
    if (listening) {
      speechSupported ? recRef.current?.stop() : stopRecorder();
      return;
    }
    if (speechSupported) {
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
      return;
    }
    // Sin SpeechRecognition (Safari): grabar y transcribir con Gemini.
    // Si hay varias claves guardadas (separadas por comas, para turnarse al clonar), aquí basta con la primera.
    const geminiApiKey = splitApiKeys(useStudio.getState().settings.geminiApiKey)[0] ?? "";
    if (!geminiApiKey) {
      useStudio
        .getState()
        .toast("Para dictar por voz en este navegador hace falta una clave gratuita de Google en Ajustes (se usa solo para convertir tu voz en texto).", "error");
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        streamRef.current = stream;
        const mimeType = ["audio/mp4", "audio/webm", "audio/ogg"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
        const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        const chunks: Blob[] = [];
        rec.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data);
        };
        rec.onstop = async () => {
          streamRef.current?.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
          recorderRef.current = null;
          setListening(false);
          if (!chunks.length) return;
          setTranscribing(true);
          try {
            const blob = new Blob(chunks, { type: rec.mimeType || mimeType || "audio/webm" });
            const base64 = await blobToBase64(blob);
            const text = await transcribeAudio(geminiApiKey, base64, blob.type);
            if (text) onText(text);
          } catch (err) {
            useStudio.getState().toast(`No se pudo transcribir el audio: ${(err as Error).message}`, "error");
          } finally {
            setTranscribing(false);
          }
        };
        recorderRef.current = rec;
        rec.start();
        setListening(true);
      })
      .catch(() => {
        useStudio.getState().toast("El navegador no tiene permiso para usar el micrófono. Revisa los permisos del sitio.", "error");
      });
  };

  return (
    <button
      type="button"
      className={`btn icon${big ? " big" : ""}${listening ? " mic-on" : ""}`}
      aria-label={listening ? "Detener dictado por voz" : transcribing ? "Transcribiendo…" : "Hablar en vez de escribir"}
      title={listening ? "Detener dictado" : transcribing ? "Transcribiendo…" : "Hablar en vez de escribir"}
      onClick={toggle}
      disabled={disabled || transcribing}
    >
      {transcribing ? <span className="spinner" /> : <Icon name="mic" />}
    </button>
  );
}
