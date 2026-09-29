import { useStudio, IS_DEMO } from "../store/studio";

/**
 * Aviso para las funciones que necesitan el servidor.
 * `worksServerless`: la función también funciona en la versión de un solo archivo (sin servidor).
 */
export function ServerNotice({ feature, worksServerless = false }: { feature: string; worksServerless?: boolean }) {
  const health = useStudio((s) => s.health);
  const ai = useStudio((s) => s.ai);
  if (health) return null;
  const standalone = ai === "direct";
  if (standalone && worksServerless) return null;
  return (
    <div className="notice warning" style={{ marginBottom: 12 }}>
      {standalone ? (
        <>
          En la versión de un solo archivo {feature} no está disponible porque necesita un servidor. En el modo <b>Fácil</b> puedes clonar
          webs con la IA.
        </>
      ) : IS_DEMO ? (
        <>
          En esta demo web {feature} no está disponible: necesita el servidor local. Descarga el proyecto y ejecuta <code>npm run dev</code>{" "}
          para usarlo.
        </>
      ) : (
        <>
          {feature.charAt(0).toUpperCase() + feature.slice(1)} necesita el servidor local. Arráncalo con <code>npm run dev</code> y recarga
          la página.
        </>
      )}
    </div>
  );
}
