import { describe, expect, it } from "vitest";
import { ingestWithFetcher, type BinaryFetcher, type TextFetcher } from "../shared/ingestCore";

describe("clonado de imágenes reales", () => {
  it("descarga las imágenes y las guarda como ficheros del proyecto, reescribiendo las referencias", async () => {
    const html = `<html><head></head><body>
      <img src="/logo.png" alt="Logo">
      <img src="/logo.png" alt="Logo repetido">
      <div style="background:url(/bg.jpg)"></div>
    </body></html>`;
    const fetcher: TextFetcher = async (url) => {
      if (url !== "https://site.test/") throw new Error("404");
      return { finalUrl: url, status: 200, contentType: "text/html", text: html };
    };
    const requested: string[] = [];
    const fetchBinary: BinaryFetcher = async (url) => {
      requested.push(url);
      if (url.endsWith(".jpg")) return { contentType: "image/jpeg", base64: "Zm9uZG8=" };
      return { contentType: "image/png", base64: "bG9nbw==" };
    };
    const result = await ingestWithFetcher(fetcher, { url: "https://site.test/" }, fetchBinary);

    // El logo se pide una sola vez aunque se use dos veces en la página
    expect(requested.filter((u) => u === "https://site.test/logo.png")).toHaveLength(1);

    const assetPaths = Object.keys(result.files).filter((p) => p.startsWith("assets/"));
    expect(assetPaths.length).toBe(2);
    const logoPath = assetPaths.find((p) => /logo/.test(p))!;
    const bgPath = assetPaths.find((p) => /bg/.test(p))!;
    expect(result.files[logoPath]).toBe("data:image/png;base64,bG9nbw==");
    expect(result.files[bgPath]).toBe("data:image/jpeg;base64,Zm9uZG8=");

    // El HTML y el CSS ya no apuntan a la web original, sino a los ficheros locales
    expect(result.files["index.html"]).not.toContain("site.test/logo.png");
    expect(result.files["index.html"]).toContain(`src="${logoPath}"`);
    expect(result.files["index.html"]).toContain(bgPath);
  });

  it("si una imagen no se puede descargar, se avisa pero no se rompe el clonado", async () => {
    const html = `<html><body><img src="/roto.png" alt=""></body></html>`;
    const fetcher: TextFetcher = async () => ({ finalUrl: "https://site.test/", status: 200, contentType: "text/html", text: html });
    const fetchBinary: BinaryFetcher = async () => {
      throw new Error("404");
    };
    const result = await ingestWithFetcher(fetcher, { url: "https://site.test/" }, fetchBinary);
    expect(Object.keys(result.files).some((p) => p.startsWith("assets/"))).toBe(false);
    expect(result.files["index.html"]).toContain("site.test/roto.png");
    expect(result.warnings.some((w) => /no se pudieron descargar/.test(w))).toBe(true);
  });
});
