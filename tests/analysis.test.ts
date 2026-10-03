import { describe, expect, it } from "vitest";
import { analyzeProject } from "../shared/analysis";

describe("analyzeProject", () => {
  it("analiza el proyecto actual sin red", () => {
    const r = analyzeProject(
      {
        "index.html": `<html><head><title>Demo</title><link rel="stylesheet" href="styles.css"></head><body><h1>Hola</h1><h3>Salto</h3><img src="logo.png"><input type="text"></body></html>`,
        "styles.css": ":root{--brand:#ff0000} body{color:#333;background:url(fondo.jpg)} @media (min-width: 600px){h1{font-size:3rem}}",
      },
      "Mi proyecto",
    );
    expect(r.title).toBe("Demo");
    expect(r.outline.map((o) => o.level)).toEqual([1, 3]);
    expect(r.a11y.map((i) => i.rule)).toEqual(expect.arrayContaining(["html-lang", "image-alt", "form-label", "heading-order"]));
    expect(r.css.customProperties).toContainEqual({ name: "--brand", value: "#ff0000" });
    expect(r.css.breakpoints).toEqual(["600px"]);
    expect(r.assets.map((a) => a.url)).toEqual(expect.arrayContaining(["logo.png", "styles.css", "fondo.jpg"]));
  });
});
