import { describe, expect, it } from "vitest";
import { IMPROVE_CHANGE_PROMPT, REFERENCE_PROMPT, SYSTEM_PROMPT, buildFilesContext, trimLinkedPagesForBudget, FILE_CHAR_BUDGET_GEMINI } from "../shared/prompts";

describe("instrucciones de fidelidad de logotipos", () => {
  it("REFERENCE_PROMPT prohíbe sustituir logotipos por bloques de color", () => {
    expect(REFERENCE_PROMPT).toMatch(/nunca los sustituyas por un bloque de color/i);
    expect(REFERENCE_PROMPT).toMatch(/logotipos de marcas/i);
  });

  it("SYSTEM_PROMPT da una alternativa real para logotipos de marcas sin captura (favicon de Google) en vez de inventar una URL", () => {
    expect(SYSTEM_PROMPT).toMatch(/google\.com\/s2\/favicons/i);
    expect(SYSTEM_PROMPT).toMatch(/no inventes una URL de imagen a la fuerza/i);
  });

  it("SYSTEM_PROMPT exige un onerror que evite dejar un hueco o un icono de imagen rota", () => {
    expect(SYSTEM_PROMPT).toMatch(/onerror/i);
    expect(SYSTEM_PROMPT).toMatch(/nunca ve un hueco/i);
  });
});

describe("SYSTEM_PROMPT: el código va antes que la explicación", () => {
  it("pide devolver los <file> PRIMERO y deja la explicación para el final", () => {
    const fileIdx = SYSTEM_PROMPT.search(/PRIMERO[\s\S]*?<file path=/i);
    const explanationIdx = SYSTEM_PROMPT.search(/explicaci[oó]n.*FINAL|FINAL.*explicaci[oó]n/i);
    expect(fileIdx).toBeGreaterThanOrEqual(0);
    expect(explanationIdx).toBeGreaterThan(fileIdx);
  });

  it("explica por qué (si la respuesta se corta, perder la explicación no importa; perder el código sí)", () => {
    expect(SYSTEM_PROMPT).toMatch(/se corta.*c[oó]digo del cambio|c[oó]digo del cambio.*se corta/i);
  });
});

describe("fidelidad a instrucciones largas o con varios pasos", () => {
  it("SYSTEM_PROMPT exige cumplir todos los puntos de un flujo largo, no solo el primero", () => {
    expect(SYSTEM_PROMPT).toMatch(/varios pasos, puntos o condiciones encadenadas/i);
    expect(SYSTEM_PROMPT).toMatch(/no resumas ni simplifiques el flujo pedido/i);
  });
});

describe("trimLinkedPagesForBudget (proyectos multi-página grandes)", () => {
  const big = "x".repeat(60_000);
  const files = {
    "index.html": "<html>principal</html>",
    "styles.css": "body{}",
    "pages/acceso/index.html": `<html>acceso ${big}</html>`,
    "pages/acceso/styles.css": big,
    "pages/menu/index.html": `<html>menu ${big}</html>`,
    "pages/menu/styles.css": big,
  };

  it("no toca nada si ya cabe en el presupuesto", () => {
    const out = trimLinkedPagesForBudget(files, "cambia el color del botón", 10_000_000);
    expect(out).toEqual(files);
  });

  it("si no cabe, omite las páginas enlazadas no mencionadas pero dejas un marcador, y nunca toca la principal", () => {
    const out = trimLinkedPagesForBudget(files, "cambia el color del botón", 50_000);
    expect(out["index.html"]).toBe(files["index.html"]); // la principal nunca se recorta
    expect(out["pages/acceso/index.html"]).toMatch(/Página clonada "acceso"/);
    expect(out["pages/acceso/styles.css"]).toBeUndefined(); // su CSS se omite del todo, no hace falta ni marcador
    expect(out["pages/menu/index.html"]).toMatch(/Página clonada "menu"/);
  });

  it("si el usuario nombra una página, esa se conserva completa aunque toque recortar", () => {
    const out = trimLinkedPagesForBudget(files, "en la página de acceso, cambia el título", 50_000);
    expect(out["pages/acceso/index.html"]).toBe(files["pages/acceso/index.html"]);
    expect(out["pages/acceso/styles.css"]).toBe(files["pages/acceso/styles.css"]);
    expect(out["pages/menu/index.html"]).toMatch(/Página clonada "menu"/); // la no mencionada sigue recortada
  });
});

describe("IMPROVE_CHANGE_PROMPT (idealizar un cambio dictado sobre un proyecto ya creado)", () => {
  it("no genera código ni aplica el cambio, solo devuelve la instrucción pulida", () => {
    expect(IMPROVE_CHANGE_PROMPT).toMatch(/NO generes HTML, CSS, JavaScript ni ningún <file>/i);
    expect(IMPROVE_CHANGE_PROMPT).toMatch(/NO apliques el cambio tú mismo/i);
  });

  it("pide nombrar el elemento exacto y dejar claro que el resto no se toca", () => {
    expect(IMPROVE_CHANGE_PROMPT).toMatch(/n[oó]mbralo tal cual aparece en el código/i);
    expect(IMPROVE_CHANGE_PROMPT).toMatch(/el resto del proyecto debe quedar exactamente igual/i);
  });
});

describe("buildFilesContext (aviso cuando el proyecto no cabe en el proveedor de IA)", () => {
  const files = { "index.html": "x".repeat(60_000), "styles.css": "y".repeat(60_000) };

  it("si hay una IA gratuita con mucho más sitio (Gemini), sugiere añadirla en vez de pedir editar el código a mano", () => {
    expect(() => buildFilesContext(files, undefined, 110_000)).toThrowError(
      expect.objectContaining({ name: "SizeError", message: expect.stringMatching(/añade una clave gratuita de google/i) }),
    );
  });

  it("si ya se usa el proveedor con más sitio (Gemini) y ni así cabe, no sugiere añadir Gemini (ya está puesto)", () => {
    const huge = { "index.html": "x".repeat(FILE_CHAR_BUDGET_GEMINI + 1) };
    expect(() => buildFilesContext(huge, undefined, FILE_CHAR_BUDGET_GEMINI)).toThrowError(
      expect.objectContaining({ name: "SizeError", message: expect.not.stringMatching(/añade una clave gratuita de google/i) }),
    );
  });
});
