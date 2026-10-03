import { describe, expect, it } from "vitest";
import { ingestWithFetcher, type TextFetcher } from "../shared/ingestCore";

describe("quitar avisos de cookies", () => {
  it("quita un aviso de un proveedor conocido (OneTrust)", async () => {
    const html = `<html><body>
      <div id="onetrust-banner-sdk">Usamos cookies <button>Aceptar</button></div>
      <h1>Contenido real de la página</h1>
    </body></html>`;
    const fetcher: TextFetcher = async () => ({ finalUrl: "https://site.test/", status: 200, contentType: "text/html", text: html });
    const result = await ingestWithFetcher(fetcher, { url: "https://site.test/" });
    expect(result.files["index.html"]).not.toContain("onetrust-banner-sdk");
    expect(result.files["index.html"]).toContain("Contenido real de la página");
    expect(result.warnings.some((w) => /aviso de cookies/.test(w))).toBe(true);
  });

  it("quita un aviso hecho a medida (sin proveedor conocido) por la combinación de texto y botones", async () => {
    const html = `<html><body>
      <div role="dialog" class="my-custom-banner">
        <p>¡Cookies! Usamos cookies propias y de terceros.</p>
        <button>Aceptar</button>
        <button>Rechazar</button>
        <button>Configurar</button>
      </div>
      <h1>Bienvenido a mi banco</h1>
    </body></html>`;
    const fetcher: TextFetcher = async () => ({ finalUrl: "https://banco.test/", status: 200, contentType: "text/html", text: html });
    const result = await ingestWithFetcher(fetcher, { url: "https://banco.test/" });
    expect(result.files["index.html"]).not.toContain("Usamos cookies propias");
    expect(result.files["index.html"]).toContain("Bienvenido a mi banco");
  });

  it("no toca contenido real que solo menciona la palabra cookie sin ser un aviso de consentimiento", async () => {
    const html = `<html><body>
      <article><h1>Receta de galletas (cookies)</h1><p>Hoy hacemos cookies de chocolate.</p></article>
    </body></html>`;
    const fetcher: TextFetcher = async () => ({ finalUrl: "https://recetas.test/", status: 200, contentType: "text/html", text: html });
    const result = await ingestWithFetcher(fetcher, { url: "https://recetas.test/" });
    expect(result.files["index.html"]).toContain("Receta de galletas");
    expect(result.files["index.html"]).toContain("Hoy hacemos cookies de chocolate");
  });
});
