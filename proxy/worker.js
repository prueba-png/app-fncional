/*
 * DevStudio Pro — proxy de descarga (Cloudflare Worker, plan gratuito).
 *
 * Sirve para clonar webs PÚBLICAS por enlace sin depender de servicios de
 * terceros. Descarga la dirección que se le pide y la devuelve con permiso de
 * lectura (CORS) para que la app la use desde el navegador o el móvil.
 *
 * CÓMO PUBLICARLO (gratis, unos 5 minutos, sin tarjeta):
 *   1. Entra en https://dash.cloudflare.com y crea una cuenta gratuita.
 *   2. Menú «Workers & Pages» → «Create» → «Create Worker» → «Deploy».
 *   3. Pulsa «Edit code», borra lo que haya y pega TODO este archivo. «Deploy».
 *   4. Copia la dirección que te da (algo como https://TU-NOMBRE.workers.dev).
 *   5. En DevStudio Pro → Ajustes → «Mi servidor de descarga», pega esa
 *      dirección y guarda. Listo: los clones por enlace usarán tu servidor.
 *
 * Nota: solo descarga páginas públicas. No sirve para páginas con inicio de
 * sesión ni para saltarse protecciones.
 */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "*",
};
const MAX_BYTES = 12 * 1024 * 1024;

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const here = new URL(request.url);
    const target = here.searchParams.get("url");
    if (!target) return json({ error: "Falta el parámetro url" }, 400);
    let t;
    try {
      t = new URL(target);
    } catch {
      return json({ error: "URL no válida" }, 400);
    }
    if (t.protocol !== "http:" && t.protocol !== "https:") return json({ error: "Solo http(s)" }, 400);
    // No se permite apuntar a direcciones internas
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1)/i.test(t.hostname)) return json({ error: "Dirección no permitida" }, 403);

    try {
      const upstream = await fetch(t.toString(), {
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
          Accept: request.headers.get("accept") || "text/html,application/xhtml+xml,image/*,*/*;q=0.8",
          "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        },
        cf: { cacheTtl: 300, cacheEverything: true },
      });
      const len = Number(upstream.headers.get("content-length") || 0);
      if (len > MAX_BYTES) return json({ error: "Recurso demasiado grande" }, 413);
      const headers = new Headers(CORS);
      const ct = upstream.headers.get("content-type");
      if (ct) headers.set("content-type", ct);
      headers.set("x-proxy-status", String(upstream.status));
      headers.set("x-final-url", upstream.url);
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch (e) {
      return json({ error: "No se pudo descargar: " + (e && e.message ? e.message : e) }, 502);
    }
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "content-type": "application/json" } });
}
