import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import { normalizeUrl } from "../src/store/easy";
import { detectClientRendered } from "../server/lib/domAnalyzer";

describe("normalizeUrl", () => {
  it("acepta direcciones sin protocolo y rechaza texto que no es una URL", () => {
    expect(normalizeUrl("ejemplo.com")).toBe("https://ejemplo.com/");
    expect(normalizeUrl("  http://a.b/c?d=1 ")).toBe("http://a.b/c?d=1");
    expect(normalizeUrl("hola mundo")).toBeNull();
    expect(normalizeUrl("palabra")).toBeNull();
    expect(normalizeUrl("")).toBeNull();
  });
});

describe("detectClientRendered", () => {
  it("detecta aplicaciones que se montan con JavaScript", () => {
    const spa = cheerio.load(`<html><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>`);
    expect(detectClientRendered(spa)).toBe(true);
    const next = cheerio.load(`<html><body><div id="__next"><div></div></div><script src="/_next/app.js"></script></body></html>`);
    expect(detectClientRendered(next)).toBe(true);
  });

  it("no marca páginas con contenido real", () => {
    const text = "Contenido real de la página con bastante texto. ".repeat(10);
    const page = cheerio.load(`<html><body><main><h1>Hola</h1><p>${text}</p></main><script src="/a.js"></script></body></html>`);
    expect(detectClientRendered(page)).toBe(false);
    const noScripts = cheerio.load(`<html><body><div id="root"></div></body></html>`);
    expect(detectClientRendered(noScripts)).toBe(false);
    const smallWithTracker = cheerio.load(
      `<html><body><main><h1>Pan artesanal cada mañana</h1><p>Horneamos con masa madre desde 1987.</p><img src="/pan.jpg" alt="Pan"></main><script src="/tracker.js"></script></body></html>`,
    );
    expect(detectClientRendered(smallWithTracker)).toBe(false);
  });
});
