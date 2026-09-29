import { describe, expect, it } from "vitest";
import { parseFileBlocks, sanitizePath, summarizeFileBlocks } from "../shared/fileBlocks";

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
});
