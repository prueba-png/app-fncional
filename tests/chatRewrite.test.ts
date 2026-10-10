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

/** Emite texto en bruto (para simular un trozo de un <file> a medio terminar o su continuación). */
function textChunk(text: string, stopReason: string | null = "end_turn") {
  return async (_req: unknown, onEvent: (e: { type: string; text?: string; model?: string; stopReason?: string | null }) => void) => {
    onEvent({ type: "text", text });
    onEvent({ type: "done", model: "gemini-flash-latest (gratis)", stopReason });
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

describe("un fichero cortado por el límite de salida se sigue completando mientras haga falta (no solo una vez)", () => {
  afterEach(() => {
    streamGemini.mockReset();
  });

  it("si hacen falta varias vueltas para terminar un <file>, se insiste hasta cerrarlo del todo (sin el aviso de truncado)", async () => {
    await setUpProject();
    const full = `${ORIGINAL_CSS}\n.extra-final { color: blue; }`;
    const a = full.slice(0, 200);
    const b = full.slice(200, 400);
    const c = full.slice(400);
    streamGemini
      .mockImplementationOnce(textChunk(`<file path="styles.css">${a}`, "max_tokens"))
      .mockImplementationOnce(textChunk(b, "max_tokens"))
      .mockImplementationOnce(textChunk(`${c}</file>`, "end_turn"));

    await useChat.getState().send("añade una regla nueva de color azul al final");

    // El intento original + DOS continuaciones (antes solo se intentaba una, y con un fichero grande no bastaba)
    expect(streamGemini).toHaveBeenCalledTimes(3);
    const files = useStudio.getState().project!.files;
    expect(files["styles.css"]).toBe(full);
    const lastMsg = useChat.getState().messages.at(-1);
    expect(lastMsg?.meta?.error).toBeUndefined();
  });

  it("si de verdad nunca termina de cerrarse, se rinde tras un tope de vueltas (no se queda insistiendo para siempre) y avisa de truncado", async () => {
    await setUpProject();
    streamGemini.mockImplementation(textChunk('<file path="styles.css">siempre incompleto ', "max_tokens"));

    await useChat.getState().send("un cambio cualquiera");

    expect(streamGemini).toHaveBeenCalledTimes(6); // 1 intento inicial + 5 continuaciones (el tope)
    const lastMsg = useChat.getState().messages.at(-1);
    expect(lastMsg?.meta?.error).toMatch(/truncó/i);
  });
});
