/** Clonado de páginas en el servidor: descarga directa con protección SSRF. */
import type { IngestOptions, IngestResult } from "../../shared/types";
import { ingestWithFetcher, type BinaryFetcher, type TextFetcher } from "../../shared/ingestCore";
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

export function ingestUrl(opts: IngestOptions): Promise<IngestResult> {
  return ingestWithFetcher(serverFetcher, opts, serverBinary);
}
