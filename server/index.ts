import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ingestRouter } from "./routes/ingest";
import { llmRouter, DEFAULT_MODEL } from "./routes/llm";
import { telegramRouter } from "./routes/telegram";

const PORT = Number(process.env.DEVSTUDIO_PORT ?? 8787);
const HOST = "127.0.0.1";
const isProd = process.env.NODE_ENV === "production";
const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, "..", "dist");

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function createApp() {
  const app = express();
  app.disable("x-powered-by");

  // Protección frente a DNS rebinding y CSRF desde otras webs abiertas en el navegador:
  // sólo se aceptan peticiones dirigidas a un host local, con origen local y con la cabecera propia.
  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    const hostname = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!LOCAL_HOSTNAMES.has(hostname)) {
      res.status(403).json({ error: "Host no permitido" });
      return;
    }
    const origin = req.headers.origin;
    if (origin) {
      try {
        if (!LOCAL_HOSTNAMES.has(new URL(origin).hostname)) throw new Error();
      } catch {
        res.status(403).json({ error: "Origen no permitido" });
        return;
      }
    }
    if (req.method !== "GET" && req.headers["x-devstudio"] !== "1") {
      res.status(403).json({ error: "Falta la cabecera x-devstudio" });
      return;
    }
    next();
  });

  app.use(express.json({ limit: "80mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, version: "1.0.0", hasEnvApiKey: Boolean(process.env.ANTHROPIC_API_KEY), defaultModel: DEFAULT_MODEL });
  });
  app.use("/api/ingest", ingestRouter);
  app.use("/api/llm", llmRouter);
  app.use("/api/telegram", telegramRouter);
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Ruta no encontrada" });
  });

  if (isProd && existsSync(distDir)) {
    app.use(express.static(distDir, { index: false }));
    app.get("/{*splat}", (_req, res) => res.sendFile(path.join(distDir, "index.html")));
  }

  app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.type === "entity.too.large" ? 413 : (err.status ?? 500);
    res.status(status).json({ error: status === 413 ? "La petición es demasiado grande." : err.message });
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createApp().listen(PORT, HOST, () => {
    console.log(`\n  Ganx · servidor local en http://${HOST}:${PORT}`);
    if (!isProd) console.log("  Interfaz de desarrollo: http://127.0.0.1:5173\n");
    else if (!existsSync(distDir)) console.log("  Aviso: no existe dist/. Ejecuta `npm run build` primero.\n");
  });
}
