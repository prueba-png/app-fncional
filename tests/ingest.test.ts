import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { assertPublicUrl, isPrivateAddress } from "../server/lib/safeFetch";
import { ingestUrl } from "../server/lib/domAnalyzer";

const PAGE = `<!doctype html><html><head><title>Fixture</title>
<link rel="stylesheet" href="/css/main.css"><style>.hero{color:#fff}</style>
<script src="/app.js"></script></head>
<body onload="evil()"><header><nav><a href="/x">Inicio</a> <a href="/acceso">Acceso</a></nav></header>
<h1>Título</h1><h3>Salto</h3>
<img src="/img/a.png"><img data-src="/img/lazy.jpg" alt="lazy">
<form><input type="email" placeholder="Correo"></form>
<button></button><div class="flex items-center gap-4 bg-slate-900 md:px-6"></div>
</body></html>`;
const CSS = `@import "/css/extra.css"; :root{--brand:#6d5dfc} body{font-family:Inter,sans-serif;background:url(../img/bg.png)} @media (min-width: 768px){body{font-size:18px}}`;
const LOGIN_PAGE = `<!doctype html><html><head><title>Acceso</title></head>
<body><h1>Inicia sesión</h1><a href="/">Volver</a>
<form><input type="text" placeholder="Usuario"><input type="password" placeholder="Contraseña"><button>Entrar</button></form>
</body></html>`;

let server: http.Server;
let base = "";

beforeAll(async () => {
  process.env.ALLOW_PRIVATE_URLS = "true";
  server = http.createServer((req, res) => {
    if (req.url === "/") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
    if (req.url === "/acceso") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(LOGIN_PAGE);
    if (req.url === "/css/main.css") return res.writeHead(200, { "content-type": "text/css" }).end(CSS);
    if (req.url === "/css/extra.css") return res.writeHead(200, { "content-type": "text/css" }).end(".extra{color:rgb(1, 2, 3)}");
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  delete process.env.ALLOW_PRIVATE_URLS;
});

describe("safeFetch", () => {
  it("clasifica direcciones privadas", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("10.2.3.4")).toBe(true);
    expect(isPrivateAddress("172.20.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:192.168.1.1")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
  });

  it("bloquea destinos locales salvo que se permitan", async () => {
    delete process.env.ALLOW_PRIVATE_URLS;
    await expect(assertPublicUrl("http://127.0.0.1/")).rejects.toThrow(/bloquead/);
    await expect(assertPublicUrl("http://localhost/")).rejects.toThrow(/bloquead/);
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(/http/);
    process.env.ALLOW_PRIVATE_URLS = "true";
  });
});

describe("ingestUrl", () => {
  it("genera réplica de estudio e informe", async () => {
    const r = await ingestUrl({ url: base + "/" });
    expect(r.title).toBe("Fixture");
    const html = r.files["index.html"];
    expect(html).not.toContain("app.js");
    expect(html).not.toContain("onload");
    expect(html).toContain(`src="${base}/img/a.png"`);
    expect(html).toContain(`src="${base}/img/lazy.jpg"`);
    expect(html).toContain('href="styles.css"');
    expect(r.files["styles.css"]).toContain(".extra{color:rgb(1, 2, 3)}");
    expect(r.files["styles.css"]).toContain(`url(${base}/img/bg.png)`);
    expect(r.files["styles.css"]).toContain(".hero{color:#fff}");
    expect(r.css.customProperties).toContainEqual({ name: "--brand", value: "#6d5dfc" });
    expect(r.css.breakpoints).toEqual(["768px"]);
    const rules = r.a11y.map((i) => i.rule);
    expect(rules).toEqual(expect.arrayContaining(["html-lang", "image-alt", "form-label", "control-name", "heading-order", "landmark-main"]));
    expect(r.outline.map((o) => o.level)).toEqual([1, 3]);
    expect(r.assets.some((a) => a.url === `${base}/img/bg.png`)).toBe(true);
    expect(r.dependencies.some((d) => d.id === "tailwind")).toBe(true);
  });

  it("con multiPage, clona también las páginas enlazadas y reescribe los enlaces entre ellas", async () => {
    const r = await ingestUrl({ url: base + "/", multiPage: true, maxPages: 5 });
    // La página de acceso enlazada se clona en su propia carpeta, con su propio contenido real
    expect(r.files["pages/acceso/index.html"]).toContain("Inicia sesión");
    expect(r.files["pages/acceso/index.html"]).toContain("Usuario");
    // El enlace a esa página, en la principal, apunta ahora al fichero local (no a la web original)
    expect(r.files["index.html"]).toContain('href="pages/acceso/index.html"');
    expect(r.files["index.html"]).not.toContain(`href="${base}/acceso"`);
    // Y el enlace de vuelta, dentro de la página de acceso, apunta de nuevo a la principal
    expect(r.files["pages/acceso/index.html"]).toContain('href="index.html"');
    // Un enlace roto de la web original (/x, 404) no debe romper el clonado: simplemente se omite
    expect(r.warnings.some((w) => /clon(ó|aron).*página.*enlazada/i.test(w))).toBe(true);
  });

  it("sin multiPage (por defecto), no clona páginas enlazadas", async () => {
    const r = await ingestUrl({ url: base + "/" });
    expect(r.files["pages/acceso/index.html"]).toBeUndefined();
  });
});
