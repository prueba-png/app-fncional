import { useEffect, useRef } from "react";

interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: "release", cb: () => void): void;
}

function getWakeLock(): { request(type: "screen"): Promise<WakeLockSentinelLike> } | null {
  const nav = navigator as unknown as { wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> } };
  return nav.wakeLock ?? null;
}

/**
 * Mantiene la pantalla encendida mientras `active` sea true (p. ej. mientras la IA está generando), para
 * que el móvil no se bloquee solo y corte la conexión mientras esperas con la app abierta. Se libera sola
 * en cuanto `active` pasa a false, y el propio navegador la suelta si ocultas la pestaña (eso es normal:
 * no se puede mantener la pantalla encendida de una pestaña que no se está mirando). No existe en todos
 * los navegadores (sobre todo versiones antiguas de iOS): si no está disponible, simplemente no hace nada.
 */
export function useWakeLock(active: boolean): void {
  const lockRef = useRef<WakeLockSentinelLike | null>(null);

  useEffect(() => {
    if (!active) return;
    const api = getWakeLock();
    if (!api) return;
    let cancelled = false;

    const acquire = async () => {
      try {
        const lock = await api.request("screen");
        if (cancelled) {
          void lock.release();
          return;
        }
        lockRef.current = lock;
      } catch {
        /* denegado (p. ej. poca batería) o no soportado ahora: no es grave, solo no se mantiene encendida */
      }
    };
    void acquire();

    // El navegador suelta la marca al ocultar la pestaña; se vuelve a pedir al volver, por si sigue activo
    const onVisible = () => {
      if (document.visibilityState === "visible" && !lockRef.current) void acquire();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void lockRef.current?.release();
      lockRef.current = null;
    };
  }, [active]);
}
