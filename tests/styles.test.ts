import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Simulación mínima (sin navegador) de la cascada CSS para los botones "icono cuadrado" (.btn.icon):
// lee el CSS real tal cual está en el repo y comprueba que, para cada combinación de clases usada de
// verdad en el código (ver el "grep" de abajo), el ancho final del botón deja sitio de sobra para su
// icono una vez restado el padding horizontal. Así no hace falta un navegador real para detectar el bug
// real que hubo: `.btn.big.icon` se quedaba con el `width: 30px` de `.btn.icon` pero el `padding: 0 18px`
// de `.btn.big` (que se declara después en el fichero, así que gana en el empate de especificidad),
// dejando un hueco negativo y el SVG del icono se encogía hasta desaparecer (ancho 0).

const css = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");

/** Quita los bloques @media de nivel superior: aquí solo interesa la cascada base (sin media queries). */
function stripMediaBlocks(src: string): string {
  let out = "";
  let depth = 0;
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("@media", i)) {
      // Salta hasta el final del bloque @media (contando llaves anidadas)
      let j = src.indexOf("{", i);
      let d = 1;
      j++;
      while (d > 0 && j < src.length) {
        if (src[j] === "{") d++;
        else if (src[j] === "}") d--;
        j++;
      }
      i = j;
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

interface Rule {
  classes: Set<string>;
  decl: Record<string, string>;
  order: number;
}

/** Selectores compuestos solo por clases (p. ej. ".btn.icon"), sin combinadores ni pseudo-clases. */
function parseClassOnlyRules(src: string): Rule[] {
  const rules: Rule[] = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  let order = 0;
  while ((m = ruleRe.exec(src))) {
    const selectors = m[1].split(",").map((s) => s.trim());
    const body = m[2];
    const decl: Record<string, string> = {};
    for (const part of body.split(";")) {
      const [prop, ...rest] = part.split(":");
      if (!prop || !rest.length) continue;
      decl[prop.trim()] = rest.join(":").trim();
    }
    for (const sel of selectors) {
      if (!/^(\.[a-zA-Z0-9-]+)+$/.test(sel)) continue; // solo selectores tipo ".a.b.c"
      const classes = new Set(sel.split(".").filter(Boolean));
      rules.push({ classes, decl, order: order++ });
    }
  }
  return rules;
}

/** Resuelve la cascada para un elemento con exactamente estas clases (mismo criterio que un navegador:
 * más clases en el selector gana; con la misma especificidad, gana la regla declarada más tarde). */
function resolveCascade(rules: Rule[], elementClasses: string[]): Record<string, string> {
  const target = new Set(elementClasses);
  const matching = rules.filter((r) => [...r.classes].every((c) => target.has(c)));
  matching.sort((a, b) => a.classes.size - b.classes.size || a.order - b.order);
  const out: Record<string, string> = {};
  for (const r of matching) Object.assign(out, r.decl);
  return out;
}

function pxOf(value: string | undefined): number {
  if (!value) return 0;
  const m = /(-?\d+(?:\.\d+)?)px/.exec(value);
  return m ? parseFloat(m[1]) : 0;
}

/** padding: puede venir como shorthand ("0 18px") o ya resuelto; se quiere el total horizontal. */
function horizontalPadding(decl: Record<string, string>): number {
  if (decl["padding-left"] || decl["padding-right"]) return pxOf(decl["padding-left"]) + pxOf(decl["padding-right"]);
  const parts = (decl.padding ?? "").trim().split(/\s+/);
  if (parts.length === 1) return pxOf(parts[0]) * 2;
  if (parts.length >= 2) return pxOf(parts[1]) * 2; // CSS shorthand: [vertical, horizontal, ...]
  return 0;
}

describe("los botones cuadrados de icono (.btn.icon) dejan sitio de verdad para el icono", () => {
  const base = stripMediaBlocks(css).replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = parseClassOnlyRules(base);

  it("`.btn.big.icon` (imagen, micrófono e idealizar en la pantalla de resultado) no se encoge a ancho 0", () => {
    const decl = resolveCascade(rules, ["btn", "big", "icon"]);
    const width = pxOf(decl.width);
    const pad = horizontalPadding(decl);
    expect(width).toBeGreaterThan(0);
    // Con box-sizing: border-box (ver `*{box-sizing:border-box}` del propio styles.css), el padding resta
    // directamente del ancho total: si el padding iguala o supera el ancho, al icono (un SVG que si no se
    // le fija lo contrario puede encogerse) no le queda ancho real disponible y desaparece visualmente.
    expect(width - pad).toBeGreaterThanOrEqual(12);
  });

  it("`.btn.sm.icon` (p. ej. el micrófono en tamaño pequeño) también deja sitio", () => {
    const decl = resolveCascade(rules, ["btn", "sm", "icon"]);
    const width = pxOf(decl.width);
    const pad = horizontalPadding(decl);
    expect(width - pad).toBeGreaterThanOrEqual(12);
  });
});
