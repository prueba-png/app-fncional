/**
 * Descarga de recursos remotos con protección SSRF: sólo http/https, bloqueo
 * de direcciones privadas/loopback (salvo ALLOW_PRIVATE_URLS=true), control
 * manual de redirecciones, tiempo máximo y tamaño máximo de respuesta.
 */
import { lookup } from "node:dns/promises";
import net from "node:net";

export class FetchError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

const allowPrivate = () => String(process.env.ALLOW_PRIVATE_URLS ?? "").toLowerCase() === "true";

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

function inRange(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const PRIVATE_V4 = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
  "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4",
];

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return PRIVATE_V4.some((c) => inRange(ip, c));
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return (
      lower === "::" || lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") ||
      lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb") ||
      lower.startsWith("ff")
    );
  }
  return true;
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchError("URL no válida");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new FetchError("Sólo se admiten URLs http(s)");
  if (url.username || url.password) throw new FetchError("No se admiten credenciales en la URL");
  if (allowPrivate()) return url;

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new FetchError("Destino local bloqueado (activa ALLOW_PRIVATE_URLS=true para permitirlo)", 403);
  }
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => {
    throw new FetchError(`No se pudo resolver el dominio ${host}`, 502);
  });
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new FetchError("El destino resuelve a una red privada y está bloqueado (ALLOW_PRIVATE_URLS=true para permitirlo)", 403);
  }
  return url;
}

export interface SafeFetchResult {
  finalUrl: string;
  status: number;
  contentType: string;
  body: Buffer;
}

export interface SafeFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  accept?: string;
}

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 DevStudioPro/1.0";

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const { maxBytes = 8 * 1024 * 1024, timeoutMs = 15000, maxRedirects = 5, accept = "*/*" } = opts;
  let current = rawUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const url = await assertPublicUrl(current);
      let res: Response;
      try {
        res = await fetch(url, {
          redirect: "manual",
          signal: controller.signal,
          headers: { "user-agent": USER_AGENT, accept, "accept-language": "es,en;q=0.8" },
        });
      } catch (err) {
        if (controller.signal.aborted) throw new FetchError("Tiempo de espera agotado", 504);
        throw new FetchError(`Error de red: ${(err as Error).message}`, 502);
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        current = new URL(res.headers.get("location")!, url).toString();
        await res.body?.cancel();
        continue;
      }
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared && declared > maxBytes) {
        await res.body?.cancel();
        throw new FetchError(`El recurso supera el límite de ${Math.round(maxBytes / 1024)} KB`, 413);
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel();
            throw new FetchError(`El recurso supera el límite de ${Math.round(maxBytes / 1024)} KB`, 413);
          }
          chunks.push(value);
        }
      }
      return {
        finalUrl: url.toString(),
        status: res.status,
        contentType: res.headers.get("content-type") ?? "",
        body: Buffer.concat(chunks),
      };
    }
    throw new FetchError("Demasiadas redirecciones", 508);
  } finally {
    clearTimeout(timer);
  }
}

export function decodeBody(body: Buffer, contentType: string): string {
  const charset = contentType.match(/charset=([\w-]+)/i)?.[1] ?? sniffCharset(body) ?? "utf-8";
  try {
    return new TextDecoder(charset.toLowerCase()).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

function sniffCharset(body: Buffer): string | undefined {
  const head = body.subarray(0, 2048).toString("latin1");
  return head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
}
