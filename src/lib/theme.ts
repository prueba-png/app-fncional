/**
 * Tema claro/oscuro de la propia app (no del contenido clonado, que siempre
 * se ve como en la web real). Se aplica con `data-theme` en <html> y se
 * recuerda en este navegador.
 */
export type Theme = "dark" | "light";
const KEY = "devstudio:theme";
const THEME_COLOR: Record<Theme, string> = { dark: "#12151c", light: "#ffffff" };

export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* sin almacenamiento: se usa el valor por defecto */
  }
  return "dark";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
}

export function setTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* sin almacenamiento */
  }
}

/** Se llama una vez al arrancar la app. */
export function initTheme(): void {
  applyTheme(getTheme());
}
