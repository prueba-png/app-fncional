import { describe, expect, it } from "vitest";
import { addDependenciesToHtml, detectDependencies } from "../shared/dependencies";

describe("detectDependencies", () => {
  it("detecta Tailwind, Font Awesome y jQuery ausentes", () => {
    const files = {
      "index.html": `<html><head></head><body><div class="flex items-center gap-4 bg-slate-900 md:px-6"><i class="fa-solid fa-user"></i></div></body></html>`,
      "script.js": `$(document).ready(function(){})`,
    };
    const deps = detectDependencies(files);
    const ids = deps.map((d) => d.id);
    expect(ids).toContain("tailwind");
    expect(ids).toContain("fontawesome");
    expect(ids).toContain("jquery");
    expect(deps.every((d) => !d.included)).toBe(true);
  });

  it("marca como incluida una librería cargada por CDN", () => {
    const files = {
      "index.html": `<html><head><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css"></head><body><button class="btn btn-primary">x</button></body></html>`,
    };
    const bs = detectDependencies(files).find((d) => d.id === "bootstrap");
    expect(bs?.included).toBe(true);
  });

  it("detecta Google Fonts por font-family y las añade al HTML", () => {
    const files = { "index.html": "<html><head></head><body></body></html>", "styles.css": "body{font-family:'Poppins',sans-serif}" };
    expect(detectDependencies(files).some((d) => d.id === "google-fonts")).toBe(true);
    const html = addDependenciesToHtml(files["index.html"], ["google-fonts", "bootstrap"], files);
    expect(html).toContain("family=Poppins");
    expect(html).toMatch(/bootstrap\.bundle\.min\.js"><\/script>\s*<\/body>/);
  });
});
