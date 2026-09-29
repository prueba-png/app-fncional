import { Router } from "express";
import type { IngestOptions } from "../../shared/types";
import { FetchError } from "../lib/safeFetch";
import { ingestUrl } from "../lib/domAnalyzer";

export const ingestRouter = Router();

ingestRouter.post("/", async (req, res) => {
  const body = req.body as IngestOptions;
  if (!body?.url || typeof body.url !== "string") {
    res.status(400).json({ error: "Indica una URL." });
    return;
  }
  let url = body.url.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const result = await ingestUrl({ url, keepScripts: !!body.keepScripts, inlineStylesheets: body.inlineStylesheets !== false });
    res.json(result);
  } catch (err) {
    const status = err instanceof FetchError ? err.status : 500;
    res.status(status).json({ error: (err as Error).message });
  }
});
