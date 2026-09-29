import { useStudio, IS_DEMO } from "../store/studio";

/** Aviso para las funciones que necesitan el servidor local. */
export function ServerNotice({ feature }: { feature: string }) {
  const health = useStudio((s) => s.health);
  if (health) return null;
  return (
    <div className="notice warning" style={{ marginBottom: 12 }}>
      {IS_DEMO ? (
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
