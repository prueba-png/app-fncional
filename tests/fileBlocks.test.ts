import { describe, expect, it } from "vitest";
import { omitLargeDataUris, parseFileBlocks, restoreDataUris, sanitizePath, summarizeFileBlocks, unchangedLineRatio } from "../shared/fileBlocks";

describe("parseFileBlocks", () => {
  it("extrae ficheros completos, eliminaciones y prosa", () => {
    const text = `Añado un formulario.\n\n<file path="index.html">\n<h1>Hola</h1>\n</file>\n<file path="./css/app.css">\n\`\`\`css\nbody{}\n\`\`\`\n</file>\n<delete path="old.js" />`;
    const r = parseFileBlocks(text);
    expect(r.updated).toEqual({ "index.html": "<h1>Hola</h1>", "css/app.css": "body{}" });
    expect(r.deleted).toEqual(["old.js"]);
    expect(r.prose).toBe("Añado un formulario.");
    expect(r.incomplete).toBe(false);
  });

  it("detecta bloques truncados y no los aplica", () => {
    const r = parseFileBlocks(`Explicación\n<file path="a.css">\nbody { color: red;`);
    expect(r.updated).toEqual({});
    expect(r.incomplete).toBe(true);
    expect(r.prose).toBe("Explicación");
  });

  it("rechaza rutas peligrosas", () => {
    expect(sanitizePath("../etc/passwd")).toBeNull();
    expect(sanitizePath("/abs/x.js")).toBe("abs/x.js");
    expect(sanitizePath("a/./b")).toBeNull();
    expect(parseFileBlocks(`<file path="../x">y</file>`).updated).toEqual({});
  });

  it("resume los bloques para el historial", () => {
    expect(summarizeFileBlocks(`Ok\n<file path="a.css">x</file>`)).toBe("Ok\n[fichero actualizado: a.css]");
  });

  it("acepta comillas simples (algunos modelos gratuitos las usan en vez de dobles)", () => {
    const text = `Cambio el título.\n<file path='index.html'>\n<h1>Nuevo título</h1>\n</file>\n<delete path='old.js' />`;
    const r = parseFileBlocks(text);
    expect(r.updated).toEqual({ "index.html": "<h1>Nuevo título</h1>" });
    expect(r.deleted).toEqual(["old.js"]);
    expect(r.prose).toBe("Cambio el título.");
    expect(r.incomplete).toBe(false);
  });

  it("detecta también un bloque truncado con comillas simples", () => {
    const r = parseFileBlocks(`Explicación\n<file path='a.css'>\nbody { color: red;`);
    expect(r.updated).toEqual({});
    expect(r.incomplete).toBe(true);
    expect(r.prose).toBe("Explicación");
  });

  it("resume también los bloques con comillas simples", () => {
    expect(summarizeFileBlocks(`Ok\n<file path='a.css'>x</file>`)).toBe("Ok\n[fichero actualizado: a.css]");
  });
});

describe("omitLargeDataUris / restoreDataUris", () => {
  const bigFont = `data:font/woff2;base64,${"A".repeat(400)}`;

  it("omite una data: URL incrustada en un fichero de texto (una fuente en un @font-face) si es grande", () => {
    const css = `@font-face{src:url(${bigFont});}\nbody{color:red}`;
    const { files, restore } = omitLargeDataUris({ "styles.css": css });
    expect(files["styles.css"]).not.toContain(bigFont);
    expect(files["styles.css"]).toContain("body{color:red}");
    expect(files["styles.css"].length).toBeLessThan(css.length / 2);
    expect(restore.size).toBe(1);
  });

  it("no toca un fichero que ES por completo una data: URL (un recorte de captura guardado como su propio fichero)", () => {
    const { files, restore } = omitLargeDataUris({ "recortes/logo.png": bigFont });
    expect(files["recortes/logo.png"]).toBe(bigFont);
    expect(restore.size).toBe(0);
  });

  it("no omite data: URLs pequeñas (el marcador no ahorraría nada)", () => {
    const small = "data:image/png;base64,AAAA";
    const { files, restore } = omitLargeDataUris({ "a.css": `background:url(${small})` });
    expect(files["a.css"]).toContain(small);
    expect(restore.size).toBe(0);
  });

  it("repone el dato real si el fichero vuelve sin tocar esa parte", () => {
    const css = `@font-face{src:url(${bigFont});}\nbody{color:red}`;
    const { files, restore } = omitLargeDataUris({ "styles.css": css });
    // La IA cambia solo el color, deja el marcador de la fuente tal cual
    const aiReturned = files["styles.css"].replace("color:red", "color:blue");
    const restored = restoreDataUris({ "styles.css": aiReturned }, restore);
    expect(restored["styles.css"]).toBe(css.replace("color:red", "color:blue"));
  });

  it("si la IA sí cambia esa parte (ya no está el marcador), no repone nada encima", () => {
    const css = `@font-face{src:url(${bigFont});}\nbody{color:red}`;
    const { restore } = omitLargeDataUris({ "styles.css": css });
    const aiReturned = { "styles.css": "body{color:blue}" }; // la IA quitó la fuente a propósito
    expect(restoreDataUris(aiReturned, restore)).toEqual(aiReturned);
  });
});

describe("unchangedLineRatio (detecta reescrituras completas de un fichero existente)", () => {
  const original = Array.from({ length: 20 }, (_, i) => `  <div class="line-${i}">contenido ${i}</div>`).join("\n");

  it("devuelve 1 cuando el fichero no cambia", () => {
    expect(unchangedLineRatio(original, original)).toBe(1);
  });

  it("es alto cuando solo se tocó una línea (un cambio bien aplicado)", () => {
    const changed = original.replace("contenido 5", "contenido CINCO");
    expect(unchangedLineRatio(original, changed)).toBeGreaterThan(0.9);
  });

  it("es bajo cuando el fichero se reescribió casi entero (línea por línea distinta)", () => {
    const rewritten = Array.from({ length: 20 }, (_, i) => `  <section id="nueva-${i}">otra cosa ${i}</section>`).join("\n");
    expect(unchangedLineRatio(original, rewritten)).toBeLessThan(0.2);
  });
});
