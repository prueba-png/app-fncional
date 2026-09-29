import { Router, type Response } from "express";
import { TelegramError, scrubToken, telegramBackup, telegramRestore, telegramTest } from "../lib/telegram";

export const telegramRouter = Router();

function fail(res: Response, err: unknown, token: unknown) {
  const status = err instanceof TelegramError ? err.status : 500;
  res.status(status).json({ error: scrubToken((err as Error).message, typeof token === "string" ? token.trim() : "") });
}

telegramRouter.post("/test", async (req, res) => {
  try {
    res.json(await telegramTest(req.body ?? {}));
  } catch (err) {
    fail(res, err, req.body?.token);
  }
});

telegramRouter.post("/backup", async (req, res) => {
  try {
    res.json(await telegramBackup(req.body ?? {}));
  } catch (err) {
    fail(res, err, req.body?.token);
  }
});

telegramRouter.post("/restore", async (req, res) => {
  try {
    const buf = await telegramRestore(req.body ?? {});
    res.setHeader("content-type", "application/zip");
    res.setHeader("content-length", String(buf.byteLength));
    res.end(buf);
  } catch (err) {
    fail(res, err, req.body?.token);
  }
});
