import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import { normalizeUrl, NOSCRIPT_RE, TEXT_URL_RE, MULTIPAGE_TEXT_RE, scriptsRenderBetter } from "../src/store/easy";
import type { RenderProbe } from "../src/lib/snapshot";

const probe = (p: Partial<RenderProbe>): RenderProbe => ({ text: 0, visible: 0, height: 600, sample: "", ...p });
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

describe("scriptsRenderBetter (elige entre el clon con scripts y el estático)", () => {
  it("si sin scripts solo sale el aviso de 'activa JavaScript', prefiere los scripts aunque rindan poco texto", () => {
    const withJs = probe({ text: 5, visible: 3 }); // menos de 20 caracteres: antes esto fallaba
    const without = probe({ text: 400, visible: 1, sample: "Para poder acceder a la aplicación es necesario que actives JavaScript." });
    expect(scriptsRenderBetter(withJs, without)).toBe(true);
  });

  it("si sin scripts es el aviso y CON scripts no pintó absolutamente nada, no hay nada mejor que mostrar", () => {
    const withJs = probe({ text: 0, visible: 0 });
    const without = probe({ text: 400, visible: 1, sample: "Please enable JavaScript to run this app." });
    expect(scriptsRenderBetter(withJs, without)).toBe(false);
  });

  it("sin el aviso de JavaScript, se exige un contenido mínimo y comparable al de la versión estática", () => {
    const goodStatic = probe({ text: 500, visible: 10, sample: "Bienvenido a nuestra tienda" });
    expect(scriptsRenderBetter(probe({ text: 5, visible: 1 }), goodStatic)).toBe(false); // muy poco texto: no se fía
    expect(scriptsRenderBetter(probe({ text: 450, visible: 9 }), goodStatic)).toBe(true); // comparable: se acepta
  });

  it("sin versión estática con la que comparar, basta con que los scripts muestren contenido real", () => {
    expect(scriptsRenderBetter(probe({ text: 25, visible: 2 }), null)).toBe(true);
    expect(scriptsRenderBetter(null, null)).toBe(false);
  });
});

describe("TEXT_URL_RE (URL mencionada en 'Crear algo nuevo desde cero')", () => {
  it("detecta una URL con o sin protocolo dentro del texto libre", () => {
    expect(TEXT_URL_RE.test("Clóname https://ejemplo.com, quiero que sea exacto")).toBe(true);
    expect(TEXT_URL_RE.test("clona www.ejemplo.com tal cual")).toBe(true);
    expect(TEXT_URL_RE.test("Una landing para una cafetería, en tonos cálidos")).toBe(false);
  });

  it("detecta también un dominio sin protocolo ni «www.» (como se dicta o escribe de forma natural)", () => {
    expect(TEXT_URL_RE.test("vete a bbva.es y replica el formulario de acceso")).toBe(true);
    expect(TEXT_URL_RE.test("crea una landing para mercadona.es con su formulario de contacto")).toBe(true);
    expect(TEXT_URL_RE.test("copia el logo de stripe.com")).toBe(true);
  });

  it("no confunde un fichero, un precio o un tamaño con un dominio", () => {
    expect(TEXT_URL_RE.test("usa un icono parecido al de styles.css")).toBe(false);
    expect(TEXT_URL_RE.test("el archivo pesa 2.5 mb")).toBe(false);
    expect(TEXT_URL_RE.test("cuesta 19.99 euros al mes")).toBe(false);
  });
});


describe("MULTIPAGE_TEXT_RE (pide clonar varias páginas enlazadas en texto libre)", () => {
  it("detecta el número de páginas en dígitos o en palabra", () => {
    expect(MULTIPAGE_TEXT_RE.test("clona hasta cinco páginas de esa web")).toBe(true);
    expect(MULTIPAGE_TEXT_RE.test("clona 5 páginas enlazadas")).toBe(true);
    expect(MULTIPAGE_TEXT_RE.test("clona tres páginas más")).toBe(true);
  });

  it("detecta «todas las páginas» y la mención conjunta de menú+acceso/formulario", () => {
    expect(MULTIPAGE_TEXT_RE.test("clónala con todas las páginas")).toBe(true);
    expect(MULTIPAGE_TEXT_RE.test("quiero el menú y el acceso también")).toBe(true);
  });

  it("no se activa con una instrucción normal de una sola página", () => {
    expect(MULTIPAGE_TEXT_RE.test("Clónala tal cual, toda la página")).toBe(false);
    expect(MULTIPAGE_TEXT_RE.test("Instala solo el formulario de contacto")).toBe(false);
    expect(MULTIPAGE_TEXT_RE.test("Instala solo la sección de precios")).toBe(false);
    expect(MULTIPAGE_TEXT_RE.test("cambia los colores a tonos azules")).toBe(false);
  });

  it("detecta un solo nombre de página conocido (login, acceso, registro…), sin necesitar dos a la vez", () => {
    expect(MULTIPAGE_TEXT_RE.test("clóname la página tal cual y clóname el login de esta página")).toBe(true);
    expect(MULTIPAGE_TEXT_RE.test("clona tal cual y clona el formulario de inicio de sesión")).toBe(true);
    expect(MULTIPAGE_TEXT_RE.test("quiero que cuando le dé clic al botón acceso me lleve al login de la página, en el mismo proyecto")).toBe(true);
    expect(MULTIPAGE_TEXT_RE.test("clónala y añade también la página de registro")).toBe(true);
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
