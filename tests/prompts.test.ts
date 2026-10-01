import { describe, expect, it } from "vitest";
import { REFERENCE_PROMPT, SYSTEM_PROMPT } from "../shared/prompts";

describe("instrucciones de fidelidad de logotipos", () => {
  it("REFERENCE_PROMPT prohíbe sustituir logotipos por bloques de color", () => {
    expect(REFERENCE_PROMPT).toMatch(/nunca los sustituyas por un bloque de color/i);
    expect(REFERENCE_PROMPT).toMatch(/logotipos de marcas/i);
  });

  it("SYSTEM_PROMPT da una alternativa real para logotipos de marcas sin captura (Clearbit)", () => {
    expect(SYSTEM_PROMPT).toMatch(/logo\.clearbit\.com/i);
  });
});
