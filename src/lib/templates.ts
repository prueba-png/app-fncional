import type { FileMap } from "../../shared/types";

export interface Template {
  id: string;
  name: string;
  description: string;
  files: FileMap;
}

const blankHtml = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Nuevo prototipo</title>
    <link rel="stylesheet" href="styles.css">
  </head>
  <body>
    <main class="container">
      <h1>Nuevo prototipo</h1>
      <p>Edita los ficheros o pide cambios al asistente.</p>
    </main>
    <script src="script.js"></script>
  </body>
</html>
`;

const blankCss = `:root {
  --bg: #0f1115;
  --fg: #e8eaf0;
  --accent: #6d5dfc;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100vh;
  background: var(--bg);
  color: var(--fg);
}

.container {
  max-width: 960px;
  margin: 0 auto;
  padding: 4rem 1.5rem;
}

h1 { color: var(--accent); }
`;

const landingHtml = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Landing · Producto</title>
    <link rel="stylesheet" href="styles.css">
  </head>
  <body>
    <header class="site-header">
      <a class="brand" href="#">Nimbus</a>
      <nav aria-label="Principal">
        <ul>
          <li><a href="#features">Funciones</a></li>
          <li><a href="#pricing">Precios</a></li>
          <li><a href="#contact">Contacto</a></li>
        </ul>
      </nav>
    </header>

    <main>
      <section class="hero">
        <h1>Construye más rápido, con menos fricción</h1>
        <p>Una plataforma que convierte ideas en prototipos listos para compartir.</p>
        <a class="button" href="#contact">Empezar gratis</a>
      </section>

      <section id="features" class="features" aria-labelledby="features-title">
        <h2 id="features-title">Funciones</h2>
        <div class="grid">
          <article class="card"><h3>Rápido</h3><p>Resultados en segundos.</p></article>
          <article class="card"><h3>Seguro</h3><p>Todo se ejecuta localmente.</p></article>
          <article class="card"><h3>Flexible</h3><p>Exporta el código cuando quieras.</p></article>
        </div>
      </section>

      <section id="contact" class="contact" aria-labelledby="contact-title">
        <h2 id="contact-title">Contacto</h2>
        <form id="contact-form" novalidate>
          <label for="email">Correo electrónico</label>
          <input id="email" name="email" type="email" required autocomplete="email">
          <button class="button" type="submit">Enviar</button>
          <p class="form-status" role="status" aria-live="polite"></p>
        </form>
      </section>
    </main>

    <footer class="site-footer">© 2026 Nimbus</footer>
    <script src="script.js"></script>
  </body>
</html>
`;

const landingCss = `:root {
  --bg: #0b0d12;
  --surface: #151923;
  --fg: #eef0f6;
  --muted: #9aa3b5;
  --accent: #6d5dfc;
  --radius: 14px;
  font-family: "Inter", system-ui, sans-serif;
}

* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); line-height: 1.6; }
a { color: inherit; }

.site-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 1rem 2rem; position: sticky; top: 0;
  background: color-mix(in srgb, var(--bg) 85%, transparent); backdrop-filter: blur(8px);
}
.brand { font-weight: 700; text-decoration: none; font-size: 1.2rem; }
.site-header ul { display: flex; gap: 1.5rem; list-style: none; margin: 0; padding: 0; }
.site-header nav a { text-decoration: none; color: var(--muted); }
.site-header nav a:hover, .site-header nav a:focus-visible { color: var(--fg); }

.hero { text-align: center; padding: 6rem 1.5rem 4rem; max-width: 760px; margin: 0 auto; }
.hero h1 { font-size: clamp(2rem, 5vw, 3.4rem); line-height: 1.1; margin: 0 0 1rem; }
.hero p { color: var(--muted); font-size: 1.15rem; }

.button {
  display: inline-block; background: var(--accent); color: #fff; border: 0; cursor: pointer;
  padding: .8rem 1.4rem; border-radius: 999px; font: inherit; font-weight: 600; text-decoration: none;
}
.button:focus-visible { outline: 3px solid #fff; outline-offset: 2px; }

.features, .contact { max-width: 1000px; margin: 0 auto; padding: 4rem 1.5rem; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; }
.card { background: var(--surface); border-radius: var(--radius); padding: 1.5rem; }
.card h3 { margin-top: 0; }

form { display: grid; gap: .6rem; max-width: 420px; }
input {
  padding: .7rem .9rem; border-radius: 10px; border: 1px solid #2a3140;
  background: var(--surface); color: var(--fg); font: inherit;
}
.form-status { min-height: 1.5em; color: var(--muted); }

.site-footer { text-align: center; padding: 2rem; color: var(--muted); }
`;

const landingJs = `const form = document.getElementById("contact-form");
const status = form.querySelector(".form-status");

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const email = form.email.value.trim();
  if (!form.email.checkValidity()) {
    status.textContent = "Introduce un correo electrónico válido.";
    form.email.focus();
    return;
  }
  status.textContent = \`¡Gracias! Te escribiremos a \${email}.\`;
  form.reset();
});
`;

export const TEMPLATES: Template[] = [
  {
    id: "blank",
    name: "En blanco",
    description: "HTML + CSS + JS mínimos.",
    files: { "index.html": blankHtml, "styles.css": blankCss, "script.js": "// Tu código aquí\n" },
  },
  {
    id: "landing",
    name: "Landing page",
    description: "Cabecera, hero, rejilla de tarjetas y formulario accesible.",
    files: { "index.html": landingHtml, "styles.css": landingCss, "script.js": landingJs },
  },
  {
    id: "tailwind",
    name: "Tailwind CSS",
    description: "Prototipo con utilidades de Tailwind (Play CDN).",
    files: {
      "index.html": `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Prototipo Tailwind</title>
    <script src="https://cdn.tailwindcss.com"></script>
  </head>
  <body class="min-h-screen bg-slate-950 text-slate-100">
    <main class="mx-auto max-w-3xl px-6 py-24">
      <h1 class="text-4xl font-bold tracking-tight text-indigo-400">Hola, Tailwind</h1>
      <p class="mt-4 text-lg text-slate-400">Pide al asistente que construya tu interfaz.</p>
      <button class="mt-8 rounded-full bg-indigo-500 px-5 py-2 font-semibold hover:bg-indigo-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">Acción</button>
    </main>
  </body>
</html>
`,
    },
  },
];
