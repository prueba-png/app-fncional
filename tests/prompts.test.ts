import { describe, expect, it } from "vitest";
import { REFERENCE_PROMPT, SYSTEM_PROMPT } from "../shared/prompts";

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
