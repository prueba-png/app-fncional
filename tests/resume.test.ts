import { describe, expect, it } from "vitest";
import { canResume, resumePrompt } from "../src/lib/util";

describe("continuar una respuesta cortada", () => {
  it("reconoce los errores que se pueden continuar", () => {
    expect(canResume("La respuesta se cortó a mitad (se perdió la conexión). Vuelve a pulsar para continuar.")).toBe(true);
    expect(canResume("Se perdió la conexión al hablar con la IA (habitual con datos móviles).")).toBe(true);
    expect(canResume("Un bloque de fichero quedó incompleto y no se aplicó.")).toBe(true);
    expect(canResume("La respuesta se truncó por longitud; algún fichero no se aplicó.")).toBe(true);
    expect(canResume("Generación detenida por el usuario.")).toBe(true);
  });

  it("no ofrece continuar para errores que no dejan nada útil a medias", () => {
    expect(canResume("La clave de la IA no es válida. Revísala en Ajustes.")).toBe(false);
    expect(canResume("Google ha bloqueado esta respuesta. Prueba con otra captura o reformula la petición.")).toBe(false);
    expect(canResume(undefined)).toBe(false);
  });

  it("la instrucción de continuar incluye la petición original y pide no repetir lo ya hecho", () => {
    const p = resumePrompt("Añade un formulario de contacto");
    expect(p).toContain("Continúa exactamente desde donde la dejaste");
    expect(p).toContain("No repitas");
    expect(p).toContain("Añade un formulario de contacto");
  });
});
