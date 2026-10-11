import { afterEach, describe, expect, it, vi } from "vitest";

// Si una IA marca una imagen o web como peligrosa (ver shared/unsafeGuard.ts), ahora se prueba
// automáticamente con la siguiente IA configurada en vez de rendirse: distintos proveedores tienen
// clasificadores de seguridad distintos y no siempre coinciden en qué marcan como peligroso.
const streamGemini = vi.fn();
const streamOpenRouter = vi.fn();
vi.mock("../src/lib/freeAi", () => ({ streamGemini, streamOpenRouter, transcribeAudio: vi.fn() }));

const { useStudio } = await import("../src/store/studio");
const { useChat } = await import("../src/store/chat");

async function setUpProject(opts: { geminiKey?: string; openrouterKey?: string; aiProvider?: "gemini" | "openrouter" } = {}) {
  useStudio.setState({ ai: "direct", health: null });
  await useStudio.getState().updateSettings({
    aiProvider: opts.aiProvider ?? "gemini",
    geminiApiKey: opts.geminiKey ?? "",
    openrouterApiKey: opts.openrouterKey ?? "",
  });
  await useStudio.getState().createProject({ name: "Proyecto de prueba", files: { "index.html": "<h1>x</h1>" }, origin: { type: "blank" } });
}

/** Simula un proveedor que "resuelve" normalmente (sin lanzar) pero con un evento de error de contenido peligroso, sin texto. */
function unsafeBlockedResponse(message: string) {
  return async (_req: unknown, onEvent: (e: { type: string; message?: string }) => void) => {
    onEvent({ type: "error", message });
  };
}

function fileResponse(path: string, content: string) {
  return async (_req: unknown, onEvent: (e: { type: string; text?: string; model?: string }) => void) => {
    onEvent({ type: "text", text: `<file path="${path}">${content}</file>` });
    onEvent({ type: "done", model: "modelo (gratis)", stopReason: "end_turn" });
  };
}

describe("si una IA marca un archivo como peligroso, se prueba con la siguiente IA configurada", () => {
  afterEach(() => {
    streamGemini.mockReset();
    streamOpenRouter.mockReset();
  });

  it("Gemini resuelve con el aviso de 'potencialmente peligroso' (sin excepción, como hace Anthropic): se prueba OpenRouter y, si funciona, se usa su resultado", async () => {
    await setUpProject({ geminiKey: "k-gemini", openrouterKey: "sk-or-v1-test", aiProvider: "gemini" });
    streamGemini.mockImplementationOnce(unsafeBlockedResponse("Uno de los archivos adjuntos (imagen o captura) está marcado como potencialmente peligroso por los filtros de seguridad de la IA, así que no se puede analizar. Prueba con otra captura."));
    streamOpenRouter.mockImplementationOnce(fileResponse("index.html", "<h1>Hecho</h1>"));

    await useChat.getState().send("haz esto a partir de la captura");

    expect(streamGemini).toHaveBeenCalledTimes(1);
    expect(streamOpenRouter).toHaveBeenCalledTimes(1);
    const files = useStudio.getState().project!.files;
    expect(files["index.html"]).toBe("<h1>Hecho</h1>");
    const lastMsg = useChat.getState().messages.at(-1);
    expect(lastMsg?.meta?.error).toBeUndefined();
  });

  it("OpenRouter lanza una excepción de contenido peligroso (como ahora hace su guardia): también se prueba con la siguiente IA", async () => {
    await setUpProject({ geminiKey: "k-gemini", openrouterKey: "sk-or-v1-test", aiProvider: "openrouter" });
    streamOpenRouter.mockImplementationOnce(async () => {
      const e = new Error("Uno de los archivos adjuntos (imagen o captura) o la web visitada está marcado como potencialmente peligroso por los filtros de seguridad, así que no se puede continuar con esta IA. Prueba con otra captura, o con otra IA conectada.");
      throw e;
    });
    streamGemini.mockImplementationOnce(fileResponse("index.html", "<h1>Hecho con Gemini</h1>"));

    await useChat.getState().send("haz esto a partir de la captura");

    expect(streamOpenRouter).toHaveBeenCalledTimes(1);
    expect(streamGemini).toHaveBeenCalledTimes(1);
    const files = useStudio.getState().project!.files;
    expect(files["index.html"]).toBe("<h1>Hecho con Gemini</h1>");
    const lastMsg = useChat.getState().messages.at(-1);
    expect(lastMsg?.meta?.error).toBeUndefined();
  });

  it("si TODAS las IA configuradas marcan el archivo como peligroso, se muestra el error claro (no se queda colgado)", async () => {
    await setUpProject({ geminiKey: "k-gemini", openrouterKey: "sk-or-v1-test", aiProvider: "gemini" });
    const msg = "Uno de los archivos adjuntos (imagen o captura) está marcado como potencialmente peligroso por los filtros de seguridad de la IA, así que no se puede analizar. Prueba con otra captura.";
    streamGemini.mockImplementationOnce(unsafeBlockedResponse(msg));
    streamOpenRouter.mockImplementationOnce(unsafeBlockedResponse(msg));

    await useChat.getState().send("haz esto a partir de la captura");

    expect(streamGemini).toHaveBeenCalledTimes(1);
    expect(streamOpenRouter).toHaveBeenCalledTimes(1);
    const lastMsg = useChat.getState().messages.at(-1);
    expect(lastMsg?.meta?.error).toMatch(/potencialmente peligroso/i);
  });
});
