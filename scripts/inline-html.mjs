// Genera un único fichero HTML con todo el CSS y JS incrustados (versión de un solo archivo).
// Uso: node scripts/inline-html.mjs <carpeta-build> <nombre-salida.html>
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";

const [dir = "dist-standalone", outName = "devstudio-pro.html"] = process.argv.slice(2);
const assets = path.join(dir, "assets");
const files = readdirSync(assets);
const js = files.filter((f) => f.endsWith(".js"));
if (js.length !== 1) throw new Error(`Se esperaba un único fichero JS y hay ${js.length}: ${js.join(", ")}`);
const css = files.filter((f) => f.endsWith(".css")).map((f) => readFileSync(path.join(assets, f), "utf8").replace(/<\/style/gi, "<\\/style"));
const script = readFileSync(path.join(assets, js[0]), "utf8").replace(/<\/script/gi, "<\\/script");

let html = readFileSync(path.join(dir, "index.html"), "utf8");
html = html.replace(/\s*<script type="module"[^>]*src="[^"]+"[^>]*><\/script>/, "");
html = html.replace(/\s*<link rel="stylesheet"[^>]*href="[^"]+\.css"[^>]*>/g, "");
html = html.replace("</head>", () => `  <style>${css.join("\n")}</style>\n  </head>`);
html = html.replace("</body>", () => `  <script type="module">${script}</script>\n  </body>`);
writeFileSync(path.join(dir, outName), html);
console.log(`${path.join(dir, outName)}: ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB`);
