import type { CssStats } from "../../shared/types";

function topN(map: Map<string, number>, n: number) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([value, count]) => ({ value, count }));
}

function bump(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

const COLOR_RE = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|rgba?\([^)]+\)|hsla?\([^)]+\)|oklch\([^)]+\)/gi;

function normalizeColor(c: string): string {
  const lower = c.toLowerCase().replace(/\s+/g, " ");
  if (/^#[0-9a-f]{3}$/.test(lower)) return "#" + [...lower.slice(1)].map((ch) => ch + ch).join("");
  return lower;
}

export function analyzeCss(css: string): CssStats {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const colors = new Map<string, number>();
  const fonts = new Map<string, number>();
  const sizes = new Map<string, number>();
  const media = new Set<string>();
  const breakpoints = new Set<string>();
  const vars = new Map<string, string>();

  for (const m of withoutComments.matchAll(COLOR_RE)) bump(colors, normalizeColor(m[0]));
  for (const m of withoutComments.matchAll(/font-family\s*:\s*([^;}{]+)/gi)) bump(fonts, m[1].trim().replace(/\s*!important$/, ""));
  for (const m of withoutComments.matchAll(/font-size\s*:\s*([^;}{]+)/gi)) bump(sizes, m[1].trim());
  for (const m of withoutComments.matchAll(/@media\s*([^{]+)\{/gi)) {
    const q = m[1].trim();
    media.add(q);
    for (const b of q.matchAll(/(?:min|max)-width\s*:\s*([\d.]+(?:px|em|rem))/gi)) breakpoints.add(b[1]);
  }
  for (const m of withoutComments.matchAll(/(--[\w-]+)\s*:\s*([^;}{]+)/g)) {
    if (!vars.has(m[1]) && vars.size < 200) vars.set(m[1], m[2].trim());
  }
  const rules = (withoutComments.match(/\{/g) ?? []).length;

  return {
    bytes: Buffer.byteLength(css),
    rules,
    mediaQueries: [...media].slice(0, 50),
    customProperties: [...vars.entries()].map(([name, value]) => ({ name, value })),
    colors: topN(colors, 40),
    fontFamilies: topN(fonts, 15),
    fontSizes: topN(sizes, 20),
    breakpoints: [...breakpoints].sort((a, b) => parseFloat(a) - parseFloat(b)),
  };
}
