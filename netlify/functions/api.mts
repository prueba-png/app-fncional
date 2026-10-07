/**
 * API de la versión publicada en Netlify: clonado de webs y copias en Telegram.
 * La IA no pasa por aquí: el navegador llama directamente a Anthropic con la
 * clave del propio usuario, así no hay límite de tiempo de ejecución.
 */
import type { Config, Context } from "@netlify/functions";
import { ingestUrl } from "../../server/lib/domAnalyzer";
import { FetchError } from "../../server/lib/safeFetch";
import { TelegramError, scrubToken, telegramBackup, telegramRestore, telegramTest } from "../../server/lib/telegram";
import { DEFAULT_MODEL } from "../../shared/claudeChat";

/** Presupuesto para clonar una web: las funciones síncronas de Netlify tienen un límite de ejecución */
const INGEST_BUDGET_MS = 8_500;
/** Las peticiones a una función síncrona admiten unos 6 MB; en base64 eso deja ~4 MB de ZIP */
const MAX_BACKUP_BYTES = 4 * 1024 * 1024;

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });

export default async (req: Request, _context: Context) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, "") || "/";

  if (req.method === "GET" && path === "/health") {
    return json({ ok: true, version: "1.0.0", hasEnvApiKey: false, defaultModel: DEFAULT_MODEL, llm: false, hosted: true });
  }
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  // Solo se aceptan peticiones de la propia app (mismo origen y cabecera propia)
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== url.host) return json({ error: "Origen no permitido" }, 403);
    } catch {
      return json({ error: "Origen no permitido" }, 403);
    }
  }
  if (req.headers.get("x-devstudio") !== "1") return json({ error: "Falta la cabecera x-devstudio" }, 403);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json({ error: "Petición no válida." }, 400);

  if (path === "/ingest") {
    const raw = typeof body.url === "string" ? body.url.trim() : "";
    if (!raw) return json({ error: "Indica una URL." }, 400);
    const hasProtocol = /^https?:\/\//i.test(raw);
    const opts = { keepScripts: !!body.keepScripts, inlineStylesheets: body.inlineStylesheets !== false };
    const started = Date.now();
    try {
      try {
        return json(await ingestUrl({ url: hasProtocol ? raw : `https://${raw}`, ...opts, budgetMs: INGEST_BUDGET_MS }));
      } catch (err) {
        // Sin protocolo indicado: si HTTPS falla por red, se prueba HTTP con el tiempo que quede
        const left = INGEST_BUDGET_MS - (Date.now() - started);
        if (hasProtocol || !(err instanceof FetchError) || err.status !== 502 || /resolver el dominio/.test(err.message) || left < 2000) throw err;
        return json(await ingestUrl({ url: `http://${raw}`, ...opts, budgetMs: left }));
      }
    } catch (err) {
      return json({ error: (err as Error).message }, err instanceof FetchError ? err.status : 500);
    }
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  const fail = (err: unknown) => json({ error: scrubToken((err as Error).message, token) }, err instanceof TelegramError ? err.status : 500);
  try {
    if (path === "/telegram/test") return json(await telegramTest(body));
    if (path === "/telegram/backup") return json(await telegramBackup(body as Parameters<typeof telegramBackup>[0], MAX_BACKUP_BYTES));
    if (path === "/telegram/restore") {
      const buf = await telegramRestore(body, MAX_BACKUP_BYTES);
      return new Response(new Uint8Array(buf), { headers: { "content-type": "application/zip", "cache-control": "no-store" } });
    }
  } catch (err) {
    return fail(err);
  }
  return json({ error: "Ruta no encontrada" }, 404);
};

export const config: Config = { path: "/api/*" };
