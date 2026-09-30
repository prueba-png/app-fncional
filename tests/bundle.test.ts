import { describe, expect, it } from "vitest";
import { buildPreviewDocument, resolveLocalPath } from "../src/lib/bundle";

const files = {
  "index.html": `<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><img src="img/logo.svg"><a href="about.html">About</a><script src="./script.js" defer></script></body></html>`,
  "about.html": "<html><body>About</body></html>",
  "styles.css": "body{color:red}",
  "script.js": "console.log('</script>')",
  "img/logo.svg": "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
};

describe("buildPreviewDocument", () => {
  it("incrusta CSS/JS locales y convierte assets de texto a data URL", () => {
    const doc = buildPreviewDocument(files, { autoInjectDeps: false });
    expect(doc).toContain('<style data-file="styles.css">');
    expect(doc).toContain("body{color:red}");
    expect(doc).toContain('<script data-file="script.js">');
    expect(doc).toContain("<\\/script>");
    expect(doc).not.toContain('src="./script.js"');
    expect(doc).toContain("data:image/svg+xml");
    expect(doc).toContain('href="about.html"');
    expect(doc).toContain("__devstudio");
  });

  it("renderiza otras páginas del proyecto", () => {
    expect(buildPreviewDocument(files, { page: "about.html", bridge: false })).toContain("About");
  });

  it("resuelve rutas relativas y descarta URLs externas", () => {
    expect(resolveLocalPath("../styles.css", "pages/a.html", files)).toBe("styles.css");
    expect(resolveLocalPath("https://cdn.x/y.css", "index.html", files)).toBeNull();
    expect(resolveLocalPath("//cdn.x/y.css", "index.html", files)).toBeNull();
  });
});

describe("recursos locales guardados como imagen y dirección base", () => {
  it("usa las imágenes guardadas como data URL, también desde el CSS, y añade <base> a los clones de webs", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const html = buildPreviewDocument(
      {
        "index.html": '<html><head><link rel="stylesheet" href="styles.css"></head><body><img src="recortes/a.png"></body></html>',
        "styles.css": ".hero{background:url(recortes/a.png)}",
        "recortes/a.png": png,
      },
      { baseUrl: "https://web.example/" },
    );
    expect(html).toContain(`<img src="${png}">`);
    expect(html).toContain(`url(${png})`);
    expect(html).toContain('<base href="https://web.example/">');
  });
});

describe("scripts inyectados en la vista previa", () => {
  it("son JavaScript válido", () => {
    const html = buildPreviewDocument({ "index.html": "<html><head></head><body><p>x</p></body></html>" }, { baseUrl: "https://a.test/" });
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const code of scripts) expect(() => new Function(code)).not.toThrow();
    expect(html).toContain("/^https?:\\/\\//i");
  });
});
