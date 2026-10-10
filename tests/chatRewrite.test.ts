import { afterEach, describe, expect, it, vi } from "vitest";

// Se sustituye streamGemini por un doble controlable: la primera llamada simula una reescritura
// destructiva (el fallo real reportado: "haz funcional X" reconstruye el fichero entero de memoria);
// la segunda llamada (la corrección automática que ahora se pide sola) puede sanar el resultado o no,
// según lo que configure cada test.
const streamGemini = vi.fn();
vi.mock("../src/lib/freeAi", () => ({ streamGemini, streamOpenRouter: vi.fn(), transcribeAudio: vi.fn() }));

const { useStudio } = await import("../src/store/studio");
const { useChat } = await import("../src/store/chat");

const ORIGINAL_CSS = Array.from({ length: 40 }, (_, i) => `.regla-${i} { color: #111; padding: ${i}px; }`).join("\n");

async function setUpProject() {
  useStudio.setState({ ai: "direct", health: null });
  await useStudio.getState().updateSettings({ aiProvider: "gemini", geminiApiKey: "clave-de-prueba" });
  await useStudio.getState().createProject({ name: "Proyecto de prueba", files: { "index.html": "<button>Hola</button>", "styles.css": ORIGINAL_CSS }, origin: { type: "blank" } });
}

/** Emite un <file> completo como si fuera la respuesta en streaming de la IA. */
function fileResponse(path: string, content: string) {
  return async (_req: unknown, onEvent: (e: { type: string; text?: string; model?: string }) => void) => {
    onEvent({ type: "text", text: `<file path="${path}">${content}</file>` });
    onEvent({ type: "done", model: "gemini-flash-latest (gratis)", stopReason: "end_turn" });
  };
}

describe("corrección automática de una reescritura destructiva (antes de aplicar nada ni avisar)", () => {
  afterEach(() => {
    streamGemini.mockReset();
  });

  it("si la IA reescribe casi todo el fichero de memoria, se le pide que lo corrija y se usa la versión corregida, sin avisar al usuario", async () => {
    await setUpProject();
    const destructive = "body { all: unset; }"; // sustituye casi todo styles.css por algo mínimo, de memoria
    const fixed = `${ORIGINAL_CSS}\n.regla-0 { color: green; padding: 0px; }`; // conserva el original y aplica el cambio pedido
    streamGemini
      .mockImplementationOnce(fileResponse("styles.css", destructive))
      .mockImplementationOnce(fileResponse("styles.css", fixed));

    await useChat.getState().send("pon el color del botón en verde");

    expect(streamGemini).toHaveBeenCalledTimes(2); // el intento original + la corrección automática
    const files = useStudio.getState().project!.files;
    expect(files["styles.css"]).toBe(fixed); // se quedó con la versión corregida, no con la destructiva
    const lastMsg = useChat.getState().messages.at(-1);
    expect(lastMsg?.meta?.warning).toBeUndefined(); // se corrigió sola: no hace falta avisar
  });

  it("si la corrección automática TAMBIÉN reescribe casi todo, se avisa (como antes) y se deja la primera versión aplicada", async () => {
    await setUpProject();
    const destructive1 = "body { all: unset; }";
    const destructive2 = ".otra-cosa { background: red; }"; // la "corrección" sigue sin conservar el original
    streamGemini
      .mockImplementationOnce(fileResponse("styles.css", destructive1))
      .mockImplementationOnce(fileResponse("styles.css", destructive2));

    await useChat.getState().send("pon el color del botón en verde");

    expect(streamGemini).toHaveBeenCalledTimes(2);
    const files = useStudio.getState().project!.files;
    expect(files["styles.css"]).toBe(destructive1); // no se queda con una corrección que no corrigió nada
    const lastMsg = useChat.getState().messages.at(-1);
    expect(lastMsg?.meta?.warning).toMatch(/reescrito/i);
  });

  it("un cambio normal que SÍ conserva el fichero no dispara ninguna corrección (una sola llamada)", async () => {
    await setUpProject();
    const normal = ORIGINAL_CSS.replace("#111", "green");
    streamGemini.mockImplementationOnce(fileResponse("styles.css", normal));

    await useChat.getState().send("pon el color en verde");

    expect(streamGemini).toHaveBeenCalledTimes(1);
    const files = useStudio.getState().project!.files;
    expect(files["styles.css"]).toBe(normal);
    const lastMsg = useChat.getState().messages.at(-1);
    expect(lastMsg?.meta?.warning).toBeUndefined();
  });

  it("si el usuario pide un rediseño completo, no se corrige ni se avisa aunque cambie casi todo", async () => {
    await setUpProject();
    const destructive = "body { all: unset; }";
    streamGemini.mockImplementationOnce(fileResponse("styles.css", destructive));

    await useChat.getState().send("rediseña toda la hoja de estilos desde cero");

    expect(streamGemini).toHaveBeenCalledTimes(1);
    const files = useStudio.getState().project!.files;
    expect(files["styles.css"]).toBe(destructive);
    const lastMsg = useChat.getState().messages.at(-1);
    expect(lastMsg?.meta?.warning).toBeUndefined();
  });
});
