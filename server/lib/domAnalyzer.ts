/** Clonado de páginas en el servidor: descarga directa con protección SSRF. */
import type { IngestOptions, IngestResult } from "../../shared/types";
import { ingestWithFetcher, type TextFetcher } from "../../shared/ingestCore";
import { decodeBody, safeFetch } from "./safeFetch";

export { detectClientRendered } from "../../shared/analysis";
export { rewriteCssUrls } from "../../shared/ingestCore";

const serverFetcher: TextFetcher = async (url, opts) => {
  const res = await safeFetch(url, opts);
  return { finalUrl: res.finalUrl, status: res.status, contentType: res.contentType, text: decodeBody(res.body, res.contentType) };
};

export function ingestUrl(opts: IngestOptions): Promise<IngestResult> {
  return ingestWithFetcher(serverFetcher, opts);
}
