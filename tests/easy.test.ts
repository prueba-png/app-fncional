import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import { normalizeUrl, NOSCRIPT_RE, TEXT_URL_RE } from "../src/store/easy";
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

describe("NOSCRIPT_RE (aviso de 'activa JavaScript')", () => {
  it("reconoce el aviso en varios idiomas y formas", () => {
    expect(NOSCRIPT_RE.test("Please enable JavaScript to run this app.")).toBe(true);
    expect(NOSCRIPT_RE.test("JavaScript is disabled in your browser.")).toBe(true);
    expect(NOSCRIPT_RE.test("Para poder acceder a la aplicación es necesario que actives JavaScript.")).toBe(true);
    expect(NOSCRIPT_RE.test("Esta página necesita JavaScript para funcionar.")).toBe(true);
    expect(NOSCRIPT_RE.test("JavaScript desactivado: activa JavaScript y recarga la página.")).toBe(true);
  });

  it("no se activa con contenido real que no menciona JavaScript", () => {
    expect(NOSCRIPT_RE.test("Bienvenido a nuestra tienda online. Envíos gratis a partir de 30€.")).toBe(false);
    expect(NOSCRIPT_RE.test("Aprende JavaScript con nuestro curso online, totalmente gratis.")).toBe(false);
  });
});

describe("TEXT_URL_RE (URL mencionada en 'Crear algo nuevo desde cero')", () => {
  it("detecta una URL con o sin protocolo dentro del texto libre", () => {
    expect(TEXT_URL_RE.test("Clóname https://ejemplo.com, quiero que sea exacto")).toBe(true);
    expect(TEXT_URL_RE.test("clona www.ejemplo.com tal cual")).toBe(true);
    expect(TEXT_URL_RE.test("Una landing para una cafetería, en tonos cálidos")).toBe(false);
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
