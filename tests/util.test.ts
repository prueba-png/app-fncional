import { describe, expect, it } from "vitest";
import { sanitizeKey, splitApiKeys } from "../src/lib/util";

describe("sanitizeKey", () => {
  const SUFFIX = "0".repeat(64);
  const FAKE = `sk-or-v1-${SUFFIX}`;
  const half = Math.floor(SUFFIX.length / 2);

  it("quita espacios y saltos de línea en los bordes y en medio", () => {
    expect(sanitizeKey(`  ${FAKE}  `)).toBe(FAKE);
    expect(sanitizeKey(`sk-or-v1-${SUFFIX.slice(0, half)}\n${SUFFIX.slice(half)}`)).toBe(FAKE);
  });

  it("quita caracteres invisibles que una app de notas puede colar sin que se note (misma clave, a veces falla)", () => {
    // Espacio de ancho cero (U+200B) insertado a mitad de la clave: visualmente idéntica, pero rompe la validación
    const withZeroWidth = `sk-or-v1-${SUFFIX.slice(0, half)}​${SUFFIX.slice(half)}`;
    expect(sanitizeKey(withZeroWidth)).toBe(FAKE);
    // Guion suave (U+00AD) y marca de izquierda a derecha (U+200E), otros invisibles habituales
    const withOthers = `‎${FAKE}­`;
    expect(sanitizeKey(withOthers)).toBe(FAKE);
  });

  it("no toca los caracteres visibles de la clave", () => {
    expect(sanitizeKey(FAKE)).toBe(FAKE);
  });
});

describe("splitApiKeys (varias claves de Google, cada una con su propio cupo)", () => {
  it("separa por comas, punto y coma o saltos de línea, limpiando cada una", () => {
    expect(splitApiKeys("AIzaAAA,AIzaBBB")).toEqual(["AIzaAAA", "AIzaBBB"]);
    expect(splitApiKeys("AIzaAAA\nAIzaBBB")).toEqual(["AIzaAAA", "AIzaBBB"]);
    expect(splitApiKeys("AIzaAAA; AIzaBBB")).toEqual(["AIzaAAA", "AIzaBBB"]);
    expect(splitApiKeys("  AIzaAAA  ,  AIzaBBB  ")).toEqual(["AIzaAAA", "AIzaBBB"]);
  });

  it("con una sola clave, se comporta igual que antes", () => {
    expect(splitApiKeys("AIzaSoloUna")).toEqual(["AIzaSoloUna"]);
    expect(splitApiKeys("")).toEqual([]);
    expect(splitApiKeys("   ")).toEqual([]);
  });

  it("quita duplicados", () => {
    expect(splitApiKeys("AIzaAAA,AIzaAAA,AIzaBBB")).toEqual(["AIzaAAA", "AIzaBBB"]);
  });
});
