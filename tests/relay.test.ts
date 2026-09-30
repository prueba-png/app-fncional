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
