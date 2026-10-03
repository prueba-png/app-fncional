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

describe("almacenamiento en el iframe sin allow-same-origin", () => {
  it("sustituye localStorage por uno en memoria cuando el real lanza un error (sandbox sin allow-same-origin)", () => {
    const html = buildPreviewDocument({ "index.html": "<html><head></head><body><p>x</p></body></html>" }, { bridge: false, autoInjectDeps: false });
    const script = html.match(/<script>([\s\S]*?patch\("sessionStorage"\);[\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();

    // Simula exactamente el fallo real de Chrome en un iframe sandbox sin "allow-same-origin"
    const fakeWindow: Record<string, unknown> = {};
    Object.defineProperty(fakeWindow, "localStorage", {
      get() {
        throw new Error("Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.");
      },
      configurable: true,
    });
    fakeWindow.sessionStorage = { setItem: () => {}, removeItem: () => {} }; // esta sí funciona

    new Function("window", script!)(fakeWindow);

    const ls = fakeWindow.localStorage as Storage;
    expect(() => ls.setItem("k", "v")).not.toThrow();
    expect(ls.getItem("k")).toBe("v");
    ls.removeItem("k");
    expect(ls.getItem("k")).toBeNull();
    // La que sí funcionaba no se ha tocado
    expect(typeof (fakeWindow.sessionStorage as { setItem: unknown }).setItem).toBe("function");
  });

  it("sustituye document.cookie por uno en memoria cuando el real lanza un error", () => {
    const html = buildPreviewDocument({ "index.html": "<html><head></head><body><p>x</p></body></html>" }, { bridge: false, autoInjectDeps: false });
    const script = html.match(/<script>([\s\S]*?patch\("sessionStorage"\);[\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();

    const fakeWindow: Record<string, unknown> = { localStorage: { setItem() {}, removeItem() {} }, sessionStorage: { setItem() {}, removeItem() {} } };
    const fakeDocument: Record<string, unknown> = {};
    Object.defineProperty(fakeDocument, "cookie", {
      get() {
        throw new Error("Failed to read the 'cookie' property from 'Document': The document is sandboxed and lacks the 'allow-same-origin' flag.");
      },
      set() {
        throw new Error("Failed to set the 'cookie' property on 'Document': The document is sandboxed and lacks the 'allow-same-origin' flag.");
      },
      configurable: true,
    });

    new Function("window", "document", script!)(fakeWindow, fakeDocument);

    expect(() => {
      fakeDocument.cookie = "a=1";
    }).not.toThrow();
    fakeDocument.cookie = "b=2";
    expect(fakeDocument.cookie).toBe("a=1; b=2");
  });

  it("no toca el almacenamiento si ya funciona", () => {
    const html = buildPreviewDocument({ "index.html": "<html><head></head><body><p>x</p></body></html>" }, { bridge: false, autoInjectDeps: false });
    const script = html.match(/<script>([\s\S]*?patch\("sessionStorage"\);[\s\S]*?)<\/script>/)?.[1];
    const real = { setItem: () => {}, removeItem: () => {}, getItem: () => "real" };
    const fakeWindow = { localStorage: real, sessionStorage: real };
    new Function("window", script!)(fakeWindow);
    expect(fakeWindow.localStorage).toBe(real);
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
