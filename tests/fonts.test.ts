import { describe, expect, it } from "vitest";
import { inlineFonts, ingestWithFetcher, type BinaryFetcher, type TextFetcher } from "../shared/ingestCore";
import { cssViewport } from "../src/lib/snapshot";

describe("inlineFonts", () => {
  it("incrusta las fuentes de @font-face como data: URL y deja el resto", async () => {
    const css = `@font-face{font-family:A;src:url("https://x.test/a.woff2") format("woff2"),url(https://x.test/a.ttf)}
body{background:url(https://x.test/bg.png)}`;
    const asked: string[] = [];
    const fetchBinary: BinaryFetcher = async (url) => {
      asked.push(url);
      if (url.endsWith(".ttf")) throw new Error("404");
      return { contentType: "application/octet-stream", base64: "AAAA" };
    };
    const warnings: string[] = [];
    const out = await inlineFonts(css, fetchBinary, warnings, Date.now() + 5000);
    expect(out).toContain('url("data:font/woff2;base64,AAAA")');
    expect(out).toContain("url(https://x.test/a.ttf)");
    expect(out).toContain("url(https://x.test/bg.png)");
    expect(asked).not.toContain("https://x.test/bg.png");
    expect(warnings[0]).toMatch(/1 fuente/);
  });

  it("el clonado usa el descargador binario para las fuentes de las hojas de estilo", async () => {
    const pages: Record<string, string> = {
      "https://site.test/": `<html><head><link rel="stylesheet" href="/s.css"></head><body><h1>Hola mundo, esto es una prueba</h1><p>Texto</p></body></html>`,
      "https://site.test/s.css": `@font-face{font-family:F;src:url(fonts/f.woff2)}h1{font-family:F}`,
    };
    const fetcher: TextFetcher = async (url) => {
      if (!(url in pages)) throw new Error("404");
      return { finalUrl: url, status: 200, contentType: url.endsWith(".css") ? "text/css" : "text/html", text: pages[url] };
    };
    const result = await ingestWithFetcher(fetcher, { url: "https://site.test/" }, async () => ({ contentType: "font/woff2", base64: "Zm9udA==" }));
    const css = Object.entries(result.files).filter(([p]) => p.endsWith(".css")).map(([, c]) => c).join("\n") + (result.files["index.html"] ?? "");
    expect(css).toContain("data:font/woff2;base64,Zm9udA==");
  });
});

describe("cssViewport", () => {
  it("deduce el ancho CSS de capturas de móvil a 3x y de escritorio", () => {
    expect(cssViewport(1170, 2532)).toEqual({ width: 390, height: 844 });
    expect(cssViewport(1440, 900)).toEqual({ width: 1440, height: 900 });
    expect(cssViewport(2880, 1800).width).toBe(1440);
  });
});
