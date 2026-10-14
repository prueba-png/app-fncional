import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { createBackupBundle, readZip } from "../src/lib/zip";
import type { Project } from "../src/db/db";

const project: Project = {
  id: "p_1",
  name: "Demo ñ",
  files: { "index.html": "<h1>x</h1>", "css/a.css": "a{}" },
  activeFile: "index.html",
  createdAt: 1,
  updatedAt: 2,
  origin: { type: "template" },
  autoInjectDeps: true,
};

describe("paquetes ZIP", () => {
  it("ida y vuelta de un paquete de respaldo", async () => {
    const blob = await createBackupBundle([
      { project, versions: [{ id: "v1", projectId: "p_1", createdAt: 1, message: "m", source: "create", files: project.files }], chat: [], references: [] },
    ]);
    const { kind, bundles } = await readZip(blob, "x");
    expect(kind).toBe("bundle");
    expect(bundles[0].project.files).toEqual(project.files);
    expect(bundles[0].versions).toHaveLength(1);
  });

  it("importa un ZIP de código fuente con carpeta raíz común", async () => {
    const zip = new JSZip();
    zip.file("site/index.html", "<p>hi</p>");
    zip.file("site/app.js", "1");
    zip.file("site/logo.png", "binario");
    const { kind, bundles } = await readZip(await zip.generateAsync({ type: "blob" }), "site");
    expect(kind).toBe("source");
    expect(Object.keys(bundles[0].project.files).sort()).toEqual(["app.js", "index.html"]);
  });
});
