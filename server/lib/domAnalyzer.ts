/** Clonado de páginas en el servidor: descarga directa con protección SSRF. */
import type { IngestOptions, IngestResult } from "../../shared/types";
import { ingestLinkedPages, ingestWithFetcher, type BinaryFetcher, type TextFetcher } from "../../shared/ingestCore";
import { decodeBody, safeFetch } from "./safeFetch";

export { detectClientRendered } from "../../shared/analysis";
export { rewriteCssUrls } from "../../shared/ingestCore";

const serverFetcher: TextFetcher = async (url, opts) => {
  const res = await safeFetch(url, opts);
  return { finalUrl: res.finalUrl, status: res.status, contentType: res.contentType, text: decodeBody(res.body, res.contentType) };
};

const serverBinary: BinaryFetcher = async (url, opts) => {
  const res = await safeFetch(url, { ...opts, accept: "font/woff2,font/*;q=0.9,*/*;q=0.5" });
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  return { contentType: res.contentType, base64: res.body.toString("base64") };
};

export async function ingestUrl(opts: IngestOptions): Promise<IngestResult> {
  const result = await ingestWithFetcher(serverFetcher, opts, serverBinary);
  if (!opts.multiPage) return result;
  try {
    const extra = await ingestLinkedPages(serverFetcher, serverBinary, result, opts);
    return { ...result, files: { ...result.files, ...extra.files }, warnings: [...result.warnings, ...extra.warnings] };
  } catch {
    return result; // el clonado de páginas enlazadas es un añadido: si falla, se devuelve igualmente el clon de la principal
  }
}
