/**
 * Cuando algo que la IA ha visto (una web, una imagen adjunta…) se marca como peligroso por los filtros
 * de seguridad del proveedor, no siempre llega como un error aparte: a veces el propio contenido que se
 * le muestra al modelo se sustituye por este aviso de clasificación ("User Safety: unsafe\nSafety
 * Categories: ..."), y el modelo lo repite tal cual en su respuesta, creyendo que está describiendo la
 * web o la imagen real. Se ha visto con varios proveedores (Anthropic directamente, y modelos servidos a
 * través de OpenRouter), así que la comprobación es compartida entre todos en vez de duplicarla.
 */
export const UNSAFE_CONTENT_RE = /User\s*Safety:\s*unsafe/i;
/** Caracteres del principio de cada bloque de texto que se retienen para comprobar este aviso antes de mostrarlos. */
export const UNSAFE_GUARD_CHARS = 400;

/**
 * Retiene (sin mostrarlo) el principio de cada bloque de texto que escribe la IA hasta comprobar que no
 * es el aviso de seguridad repetido tal cual; pasado ese primer tramo, o si el bloque termina antes, se
 * suelta de golpe y el resto se sigue mostrando en vivo como siempre. Una respuesta normal no pierde nada
 * ni nota el cambio (como mucho, sus primeros ~400 caracteres llegan de golpe en vez de carácter a carácter).
 */
export function createUnsafeGuard(emitText: (text: string) => void) {
  let buf: string | null = "";
  return {
    /** Procesa un trozo de texto recién llegado. Devuelve true si se ha detectado el aviso (y se ha cortado todo). */
    push(text: string): boolean {
      if (buf === null) {
        emitText(text);
        return false;
      }
      buf += text;
      if (UNSAFE_CONTENT_RE.test(buf)) {
        buf = null;
        return true;
      }
      if (buf.length >= UNSAFE_GUARD_CHARS) {
        emitText(buf);
        buf = null;
      }
      return false;
    },
    /** Al terminar un bloque de texto (o toda la respuesta): suelta lo que quedara retenido sin llegar al umbral. */
    flush(): void {
      if (buf) emitText(buf);
      buf = null;
    },
    /** Un nuevo bloque de texto empieza: se vuelve a retener desde el principio. */
    reset(): void {
      buf = "";
    },
  };
}
