/**
 * Empaquetado ZIP: exportación del código fuente y paquetes de respaldo
 * completos (proyecto + historial + chat + referencias) para Telegram.
 */
import JSZip from "jszip";
import type { ChatMessage, Project, Version, VisualReference } from "../db/db";

export const MANIFEST = "devstudio.json";
export const BUNDLE_FORMAT = "devstudio-pro/backup";
export const BUNDLE_VERSION = 1;

export interface ProjectBundle {
  project: Project;
  versions: Version[];
  chat: ChatMessage[];
  references: VisualReference[];
}

export interface BundleManifest {
  format: typeof BUNDLE_FORMAT;
  version: number;
  createdAt: string;
  app: string;
  projects: Array<{ id: string; name: string; folder: string }>;
}

function folderName(p: Project, used: Set<string>): string {
  const base =
    p.name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^\w-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "proyecto";
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base}-${i}`;
  used.add(name);
  return name;
}

/** ZIP con el código fuente del proyecto listo para abrir en cualquier editor o servidor estático. */
export async function exportSourceZip(project: Project): Promise<Blob> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(project.files)) zip.file(path, content);
  if (!("README.md" in project.files)) {
    zip.file(
      "README.md",
      `# ${project.name}\n\nExportado desde DevStudio Pro el ${new Date().toLocaleString("es")}.\n\n` +
        `Abre \`index.html\` en el navegador o sirve la carpeta con cualquier servidor estático, por ejemplo:\n\n` +
        "```bash\nnpx serve .\n```\n" +
        (project.origin.type === "url" && project.origin.detail ? `\nOrigen del análisis: ${project.origin.detail}\n` : ""),
    );
  }
  return zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

/** Paquete de respaldo completo, reimportable en DevStudio Pro. */
export async function createBackupBundle(bundles: ProjectBundle[]): Promise<Blob> {
  const zip = new JSZip();
  const used = new Set<string>();
  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    createdAt: new Date().toISOString(),
    app: "DevStudio Pro 1.0.0",
    projects: [],
  };
  for (const b of bundles) {
    const folder = folderName(b.project, used);
    manifest.projects.push({ id: b.project.id, name: b.project.name, folder });
    const dir = zip.folder(folder)!;
    for (const [path, content] of Object.entries(b.project.files)) dir.file(`src/${path}`, content);
    dir.file("project.json", JSON.stringify({ ...b.project, files: undefined }, null, 2));
    dir.file("files.json", JSON.stringify(b.project.files));
    dir.file("versions.json", JSON.stringify(b.versions));
    dir.file("chat.json", JSON.stringify(b.chat));
    dir.file("references.json", JSON.stringify(b.references));
  }
  zip.file(MANIFEST, JSON.stringify(manifest, null, 2));
  return zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

async function readJson<T>(zip: JSZip, path: string, fallback: T): Promise<T> {
  const f = zip.file(path);
  if (!f) return fallback;
  return JSON.parse(await f.async("string")) as T;
}

/**
 * Lee un ZIP: si es un paquete de respaldo devuelve sus proyectos; si es un ZIP
 * de código fuente cualquiera, lo convierte en un proyecto nuevo.
 */
export async function readZip(blob: Blob, fallbackName: string): Promise<{ kind: "bundle" | "source"; bundles: ProjectBundle[] }> {
  const zip = await JSZip.loadAsync(blob);
  const manifestFile = zip.file(MANIFEST);
  if (manifestFile) {
    const manifest = JSON.parse(await manifestFile.async("string")) as BundleManifest;
    if (manifest.format !== BUNDLE_FORMAT) throw new Error("El ZIP no es un paquete de DevStudio Pro reconocido.");
    const bundles: ProjectBundle[] = [];
    for (const entry of manifest.projects) {
      const meta = await readJson<Omit<Project, "files">>(zip, `${entry.folder}/project.json`, null as never);
      if (!meta) continue;
      const files = await readJson(zip, `${entry.folder}/files.json`, {} as Project["files"]);
      bundles.push({
        project: { ...meta, files },
        versions: await readJson(zip, `${entry.folder}/versions.json`, []),
        chat: await readJson(zip, `${entry.folder}/chat.json`, []),
        references: await readJson(zip, `${entry.folder}/references.json`, []),
      });
    }
    return { kind: "bundle", bundles };
  }

  // ZIP de código fuente: se importan los ficheros de texto
  const files: Project["files"] = {};
  const entries = Object.values(zip.files).filter((f) => !f.dir && !f.name.startsWith("__MACOSX/"));
  const prefix = commonPrefix(entries.map((e) => e.name));
  for (const e of entries) {
    if (!/\.(html?|css|m?js|jsx|tsx?|json|md|svg|txt|xml)$/i.test(e.name)) continue;
    files[e.name.slice(prefix.length)] = await e.async("string");
  }
  if (!Object.keys(files).length) throw new Error("El ZIP no contiene ficheros de texto compatibles.");
  const now = Date.now();
  return {
    kind: "source",
    bundles: [
      {
        project: {
          id: "",
          name: fallbackName,
          files,
          activeFile: "index.html" in files ? "index.html" : Object.keys(files)[0],
          createdAt: now,
          updatedAt: now,
          origin: { type: "import", detail: fallbackName },
          autoInjectDeps: true,
        },
        versions: [],
        chat: [],
        references: [],
      },
    ],
  };
}

function commonPrefix(paths: string[]): string {
  if (!paths.length) return "";
  const first = paths[0].split("/");
  let depth = 0;
  while (depth < first.length - 1 && paths.every((p) => p.split("/")[depth] === first[depth])) depth++;
  return depth ? first.slice(0, depth).join("/") + "/" : "";
}
