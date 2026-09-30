/**
 * Clonado exacto sin servidor propio: el navegador no puede descargar otras
 * webs directamente (CORS), así que usa servicios públicos de reenvío que
 * devuelven el HTML y el CSS originales. Se lanzan de forma escalonada (si el
 * primero tarda, arranca el siguiente) y gana el primero que responde bien.
 * Para webs hechas con JavaScript se pide además la página ya pintada por un
 * navegador real (r.jina.ai). Si todo falla, la app recurre a la IA.
 *
 * Solo se usan con páginas públicas: la URL que se clona pasa por el servicio.
 */
import type { IngestOptions, IngestResult } from "../../shared/types";
import { ingestWithFetcher, type BinaryFetcher, type FetchedText, type TextFetcher } from "../../shared/ingestCore";

interface Relay {
  name: string;
  url: (target: string) => string;
  /** Servicios que responden JSON en lugar del contenido tal cual */
  json?: (data: unknown) => { status: number; contentType: string; text: string } | null;
  /** Sirve también para ficheros binarios (fuentes) */
  binary?: boolean;
}

const alloriginsJson = (d: unknown) => {
  const o = d as { contents?: string; status?: { http_code?: number; content_type?: string } };
  return typeof o?.contents === "string" ? { status: o.status?.http_code ?? 200, contentType: o.status?.content_type ?? "", text: o.contents } : null;
};

export const RELAYS: Relay[] = [
  { name: "allorigins", url: (t) => `https://api.allorigins.win/raw?url=${encodeURIComponent(t)}`, binary: true },
  { name: "codetabs", url: (t) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(t)}`, binary: true },
  { name: "allorigins-json", url: (t) => `https://api.allorigins.win/get?url=${encodeURIComponent(t)}`, json: alloriginsJson },
  { name: "thingproxy", url: (t) => `https://thingproxy.freeboard.io/fetch/${t}`, binary: true },
  { name: "whateverorigin", url: (t) => `https://whateverorigin.org/get?url=${encodeURIComponent(t)}`, json: alloriginsJson },
  { name: "cors.lol", url: (t) => `https://api.cors.lol/?url=${encodeURIComponent(t)}`, binary: true },
];

/** Respuesta de error del propio servicio de reenvío (p. ej. «se necesita clave»), no la web pedida. */
export function looksLikeServiceError(text: string): boolean {
  const t = text.trim();
  return (
    t.length < 1200 &&
    /^[[{]/.test(t) &&
    /"?(error|message|detail)"?\s*[:=]/i.test(t) &&
    /api[\s_-]?key|required|invalid|quota|rate.?limit|forbidden|unauthor|not allowed|blocked|sign\s?up|get one at|too many/i.test(t)
  );
}

/** Tiempo que se espera a un servicio antes de lanzar también el siguiente */
const STAGGER_MS = 2500;

/** Último servicio que funcionó: se prueba primero en las siguientes descargas */
let preferred = 0;

/** Proxy propio del usuario (si lo ha configurado en Ajustes): se prueba antes que los públicos. */
let customProxy = "";
export function setProxyUrl(url: string): void {
  customProxy = (url ?? "").trim();
}
function customRelay(): Relay | null {
  if (!customProxy || !/^https?:\/\//i.test(customProxy)) return null;
  const join = customProxy.includes("?") ? "&" : "?";
  return { name: "tu-servidor", url: (t) => `${customProxy}${join}url=${encodeURIComponent(t)}`, binary: true };
}

function ordered(filter?: (r: Relay) => boolean): Relay[] {
  const base = [...RELAYS.slice(preferred), ...RELAYS.slice(0, preferred)];
  const list = filter ? base.filter(filter) : base;
  const custom = customRelay();
  return custom ? [custom, ...list] : list;
}

/**
 * Lanza `attempt` con cada servicio de forma escalonada y devuelve el primer resultado válido.
 * Al terminar cancela las peticiones que siguen en marcha.
 */
export async function raceRelays<T>(relays: Relay[], attempt: (relay: Relay, signal: AbortSignal) => Promise<T>, staggerMs = STAGGER_MS): Promise<T> {
  if (!relays.length) throw new Error("sin servicios disponibles");
  const controllers = relays.map(() => new AbortController());
  return new Promise<T>((resolve, reject) => {
    let started = 0;
    let failed = 0;
    let done = false;
    let lastError: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      done = true;
      clearTimeout(timer);
      controllers.forEach((c) => c.abort());
    };
    const startNext = () => {
      if (done || started >= relays.length) return;
      const i = started++;
      clearTimeout(timer);
      timer = setTimeout(startNext, staggerMs);
      attempt(relays[i], controllers[i].signal).then(
        (value) => {
          if (done) return;
          preferred = Math.max(0, RELAYS.indexOf(relays[i]));
          finish();
          resolve(value);
        },
        (err) => {
          if (done) return;
          lastError = err;
          failed++;
          if (failed === relays.length) {
            finish();
            reject(lastError instanceof Error ? lastError : new Error("sin respuesta"));
          } else startNext(); // uno falló: se lanza ya el siguiente sin esperar
        },
      );
    };
    startNext();
  });
}

function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : signal;
}

/** ¿Parece la respuesta de verdad y no una página de error del propio servicio? */
function plausible(accept: string, target: string, text: string): boolean {
  if (!text.trim()) return false;
  if (looksLikeServiceError(text)) return false; // error del propio servicio (clave requerida, límite, etc.)
  if (/text\/html/.test(accept)) {
    const head = text.slice(0, 30000);
    // Páginas de bloqueo o de límite de peticiones (Cloudflare, captchas, el propio servicio)
    if (/<title>\s*(just a moment|attention required|access denied|403 forbidden|too many requests|rate limit)/i.test(head) || /cf-browser-verification|challenge-platform|g-recaptcha|hcaptcha/i.test(head)) return false;
    if (text.length < 1500 && /(rate.?limit|too many requests|access denied|forbidden|not allowed|blocked|quota)/i.test(text)) return false;
    return /<(!doctype|html|head|body|div|main|section|title)\b/i.test(head) || /\.xml(\?|$)/i.test(target);
  }
  if (/text\/css/.test(accept)) return !/^\s*(<!doctype|<html|\{"error")/i.test(text);
  return true;
}

async function fetchThrough(relay: Relay, target: string, accept: string, timeoutMs: number, maxBytes: number, signal: AbortSignal) {
  const res = await fetch(relay.url(target), { signal: withTimeout(signal, timeoutMs), credentials: "omit", referrerPolicy: "no-referrer" });
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new Error("El recurso es demasiado grande.");
  let out: { status: number; contentType: string; text: string };
  if (relay.json) {
    const parsed = relay.json(await res.json().catch(() => null));
    if (!parsed) throw new Error(`respuesta no válida de ${relay.name}`);
    out = parsed;
  } else {
    out = { status: res.status, contentType: res.headers.get("content-type") ?? "", text: await res.text() };
  }
  if (out.text.length > maxBytes) throw new Error("El recurso es demasiado grande.");
  // Cualquier error (403 clave, 404 no encontrado, 429 límite, 5xx) significa que ese servicio no sirve: se prueba otro
  if (out.status >= 400) throw new Error(`HTTP ${out.status}`);
  if (!plausible(accept, target, out.text)) throw new Error(`respuesta no válida de ${relay.name}`);
  return out;
}

export const relayFetcher: TextFetcher = async (url, opts) => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("URL no válida");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Solo se pueden clonar direcciones http(s).");
  const target = parsed.toString();
  try {
    const res = await raceRelays(ordered(), (relay, signal) => fetchThrough(relay, target, opts.accept, opts.timeoutMs, opts.maxBytes, signal));
    return { finalUrl: target, ...res };
  } catch (err) {
    throw new Error(`No se pudo descargar la web (${(err as Error)?.message ?? "sin respuesta"}).`);
  }
};

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Fuentes: se descargan en binario a través de los servicios que devuelven el fichero tal cual. */
export const relayBinary: BinaryFetcher = (url, opts) =>
  raceRelays(ordered((r) => !!r.binary), async (relay, signal) => {
    const res = await fetch(relay.url(url), { signal: withTimeout(signal, opts.timeoutMs), credentials: "omit", referrerPolicy: "no-referrer" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    if (/text\/html|application\/json/i.test(type)) throw new Error("no es un fichero");
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.length || buf.length > opts.maxBytes) throw new Error("tamaño no válido");
    return { contentType: type, base64: toBase64(buf) };
  });

/**
 * La página tal y como la ve un navegador después de ejecutar su JavaScript
 * (r.jina.ai la abre en un navegador real). Sirve para webs hechas con React,
 * Vue, etc. y para webs que bloquean a los otros servicios.
 */
export async function fetchRendered(url: string, timeoutMs = 30_000): Promise<FetchedText> {
  const res = await fetch(`https://r.jina.ai/${url}`, {
    headers: { "X-Return-Format": "html", "X-Timeout": String(Math.round(timeoutMs / 1000) - 5), "X-With-Shadow-Dom": "true" },
    signal: AbortSignal.timeout(timeoutMs),
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!plausible("text/html", url, text)) throw new Error("respuesta no válida");
  return { finalUrl: url, status: 200, contentType: "text/html", text };
}

/** Captura de pantalla real de la web (para que la IA la copie cuando no se puede descargar su código). */
export async function fetchSiteScreenshot(url: string, timeoutMs = 30_000): Promise<{ dataUrl: string; width: number; height: number } | null> {
  const toDataUrl = async (imageUrl: string) => {
    const img = await fetch(imageUrl, { signal: AbortSignal.timeout(timeoutMs), credentials: "omit", referrerPolicy: "no-referrer" });
    if (!img.ok || !/^image\//.test(img.headers.get("content-type") ?? "")) throw new Error("sin imagen");
    const blob = await img.blob();
    return new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  };
  const size = (dataUrl: string) =>
    new Promise<{ width: number; height: number }>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve({ width: i.naturalWidth, height: i.naturalHeight });
      i.onerror = () => reject(new Error("imagen no válida"));
      i.src = dataUrl;
    });
  const sources: Array<() => Promise<string>> = [
    async () => {
      const api = `https://api.microlink.io/?url=${encodeURIComponent(url)}&screenshot=true&meta=false&viewport.width=1280&viewport.height=800&screenshot.fullPage=true&waitForTimeout=1500`;
      const res = await fetch(api, { signal: AbortSignal.timeout(timeoutMs), credentials: "omit" });
      const json = (await res.json()) as { status?: string; data?: { screenshot?: { url?: string } } };
      const shot = json?.data?.screenshot?.url;
      if (json?.status !== "success" || !shot) throw new Error("sin captura");
      return toDataUrl(shot);
    },
    () => toDataUrl(`https://image.thum.io/get/width/1280/crop/3000/noanimate/${url}`),
  ];
  for (const source of sources) {
    try {
      const dataUrl = await source();
      return { dataUrl, ...(await size(dataUrl)) };
    } catch {
      /* se prueba el siguiente */
    }
  }
  return null;
}

/** Clona una web con su código real (HTML, CSS y fuentes originales) desde el navegador. */
export async function ingestViaRelay(opts: IngestOptions): Promise<IngestResult> {
  const budgetMs = opts.budgetMs ?? 50_000;
  let first: IngestResult | null = null;
  let firstError: unknown;
  try {
    first = await ingestWithFetcher(relayFetcher, { ...opts, budgetMs }, relayBinary);
    if (!first.looksClientRendered) return first;
  } catch (err) {
    firstError = err;
  }
  // Web hecha con JavaScript (o que bloquea a los servicios): se usa la página ya pintada
  try {
    const rendered = await fetchRendered(opts.url);
    const fetcher: TextFetcher = (u, o) => (u === opts.url ? Promise.resolve(rendered) : relayFetcher(u, o));
    const result = await ingestWithFetcher(fetcher, { ...opts, keepScripts: false, budgetMs }, relayBinary);
    if (first && result.dom.totalElements < first.dom.totalElements) return first;
    return { ...result, looksClientRendered: false, warnings: [...result.warnings, "Se copió la página ya pintada por un navegador (la web se genera con JavaScript)."] };
  } catch {
    if (first) return first;
    throw firstError instanceof Error ? firstError : new Error("No se pudo descargar la web.");
  }
}
