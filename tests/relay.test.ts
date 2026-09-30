import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestViaRelay } from "../src/lib/proxyIngest";

const PAGE = `<!doctype html><html lang="es"><head><title>Tienda</title><link rel="stylesheet" href="/css/app.css"></head>
<body><header><h1>Zapatillas</h1></header><img src="/img/z.jpg" alt="Zapatilla"><script src="/app.js"></script></body></html>`;
const CSS = `body{background:#111;color:#fafafa} .hero{background:url(../img/bg.png)}`;

afterEach(() => vi.unstubAllGlobals());

describe("ingestViaRelay", () => {
  it("clona el código real usando el siguiente servicio si el primero falla", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      const relay = new URL(input);
      seen.push(relay.hostname);
      if (relay.hostname === "api.allorigins.win") throw new TypeError("Failed to fetch");
      const target = relay.searchParams.get("quest") ?? relay.searchParams.get("url") ?? "";
      if (target === "https://tienda.example/") return new Response(PAGE, { headers: { "content-type": "text/html" } });
      if (target === "https://tienda.example/css/app.css") return new Response(CSS, { headers: { "content-type": "text/css" } });
      return new Response("no", { status: 404 });
    });

    const r = await ingestViaRelay({ url: "https://tienda.example/" });
    expect(r.title).toBe("Tienda");
    expect(r.files["index.html"]).toContain("<h1>Zapatillas</h1>");
    expect(r.files["index.html"]).toContain('src="https://tienda.example/img/z.jpg"');
    expect(r.files["index.html"]).not.toContain("app.js");
    expect(r.files["styles.css"]).toContain("background:#111");
    expect(r.files["styles.css"]).toContain("url(https://tienda.example/img/bg.png)");
    expect(seen).toContain("api.codetabs.com");
  });

  it("falla con un mensaje claro si ningún servicio responde", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(ingestViaRelay({ url: "https://caida.example/" })).rejects.toThrow(/No se pudo descargar la web/);
  });
});

describe("clonado de webs hechas con JavaScript", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("usa la página ya pintada por un navegador cuando el HTML original está vacío", async () => {
    const SHELL = `<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script src="/main.js"></script></body></html>`;
    const RENDERED = `<!doctype html><html><head><title>App</title></head><body><div id="root"><h1>Catálogo de primavera</h1><p>Ofertas en toda la tienda</p><a href="/c">Ver</a></div></body></html>`;
    vi.stubGlobal("fetch", async (input: string) => {
      const u = new URL(input);
      if (u.hostname === "r.jina.ai") return new Response(RENDERED, { headers: { "content-type": "text/html" } });
      const target = u.searchParams.get("url") ?? u.searchParams.get("quest") ?? "";
      if (target === "https://spa.example/") return new Response(SHELL, { headers: { "content-type": "text/html" } });
      return new Response("", { status: 404 });
    });
    const r = await ingestViaRelay({ url: "https://spa.example/", keepScripts: true });
    expect(r.files["index.html"]).toContain("Catálogo de primavera");
    expect(r.files["index.html"]).not.toContain("main.js");
    expect(r.looksClientRendered).toBe(false);
  });

  it("descarta las páginas de error de los servicios y conserva los <link> que no se pudieron copiar", async () => {
    const PAGE2 = `<!doctype html><html><head><title>T</title><link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="/b.css"></head><body><h1>Hola mundo desde la tienda</h1><p>Texto largo de ejemplo</p></body></html>`;
    vi.stubGlobal("fetch", async (input: string) => {
      const u = new URL(input);
      const target = u.searchParams.get("url") ?? u.searchParams.get("quest") ?? "";
      // El primer servicio devuelve su propia página de error con estado 200
      if (target === "https://t.example/" && u.hostname !== "api.cors.lol") return new Response("<html><body>Rate limited</body></html>", { headers: { "content-type": "text/html" } });
      if (target === "https://t.example/") return new Response(PAGE2, { headers: { "content-type": "text/html" } });
      if (target === "https://t.example/a.css") return new Response("h1{color:red}", { headers: { "content-type": "text/css" } });
      if (target === "https://t.example/b.css") return new Response("<!doctype html><title>Error</title>", { headers: { "content-type": "text/html" } });
      return new Response("", { status: 404 });
    });
    const r = await ingestViaRelay({ url: "https://t.example/" });
    expect(r.files["index.html"]).toContain("Hola mundo desde la tienda");
    expect(r.files["styles.css"]).toContain("h1{color:red}");
    expect(r.files["index.html"]).toContain('href="https://t.example/b.css"');
    expect(r.files["index.html"]).not.toContain('href="https://t.example/a.css"');
    expect(r.files["index.html"]).toContain('<meta name="referrer" content="no-referrer">');
  });
});
