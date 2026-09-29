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
  const raw = body.url.trim();
  const hasProtocol = /^https?:\/\//i.test(raw);
  const opts = { keepScripts: !!body.keepScripts, inlineStylesheets: body.inlineStylesheets !== false };
  try {
    let result;
    try {
      result = await ingestUrl({ url: hasProtocol ? raw : `https://${raw}`, ...opts });
    } catch (err) {
      // Sin protocolo indicado: si HTTPS falla por red, se prueba HTTP
      if (hasProtocol || !(err instanceof FetchError) || err.status !== 502 || /resolver el dominio/.test(err.message)) throw err;
      result = await ingestUrl({ url: `http://${raw}`, ...opts });
    }
    res.json(result);
  } catch (err) {
    const status = err instanceof FetchError ? err.status : 500;
    res.status(status).json({ error: (err as Error).message });
  }
});
