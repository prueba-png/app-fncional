/**
 * Clonado exacto sin servidor propio: el navegador no puede descargar otras
 * webs directamente (CORS), así que usa servicios públicos de reenvío que
 * devuelven el HTML y el CSS originales. Se prueban en orden y, si todos
 * fallan, la app recurre al clonado con IA.
 *
 * Solo se usan con páginas públicas: la URL que se clona pasa por el servicio.
 */
import type { IngestOptions, IngestResult } from "../../shared/types";
import { ingestWithFetcher, type TextFetcher } from "../../shared/ingestCore";

interface Relay {
  name: string;
  url: (target: string) => string;
}

export const RELAYS: Relay[] = [
  { name: "allorigins", url: (t) => `https://api.allorigins.win/raw?url=${encodeURIComponent(t)}` },
  { name: "codetabs", url: (t) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(t)}` },
  { name: "corsproxy", url: (t) => `https://corsproxy.io/?url=${encodeURIComponent(t)}` },
];

/** Último servicio que funcionó: se prueba primero en las siguientes descargas */
let preferred = 0;

async function fetchThrough(relay: Relay, target: string, timeoutMs: number, maxBytes: number): Promise<{ status: number; contentType: string; text: string }> {
  const res = await fetch(relay.url(target), { signal: AbortSignal.timeout(timeoutMs), credentials: "omit", referrerPolicy: "no-referrer" });
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new Error("El recurso es demasiado grande.");
  const text = await res.text();
  if (text.length > maxBytes) throw new Error("El recurso es demasiado grande.");
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", text };
}

export const relayFetcher: TextFetcher = async (url, opts) => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("URL no válida");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Solo se pueden clonar direcciones http(s).");

  const order = [...RELAYS.slice(preferred), ...RELAYS.slice(0, preferred)];
  let lastError: unknown;
  for (const relay of order) {
    try {
      const res = await fetchThrough(relay, parsed.toString(), opts.timeoutMs, opts.maxBytes);
      // Algunos servicios responden 200 con su propia página de error: se descartan respuestas vacías
      if (res.status >= 500 || (res.status === 200 && !res.text.trim())) throw new Error(`HTTP ${res.status}`);
      preferred = RELAYS.indexOf(relay);
      return { finalUrl: parsed.toString(), ...res };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`No se pudo descargar la web (${(lastError as Error)?.message ?? "sin respuesta"}).`);
};

/** Clona una web con su código real (HTML y CSS originales) desde el navegador. */
export function ingestViaRelay(opts: IngestOptions): Promise<IngestResult> {
  return ingestWithFetcher(relayFetcher, { ...opts, budgetMs: opts.budgetMs ?? 45_000 });
}
