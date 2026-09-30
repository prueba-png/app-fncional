import { useStudio } from "../store/studio";
import { Dialog } from "./Dialog";
import { Icon, type IconName } from "./Icon";

interface Entry {
  icon: IconName;
  name: string;
  what: string;
}

const EASY: Entry[] = [
  { icon: "globe", name: "Clonar (enlace)", what: "Pega la dirección de una web y pulsa Clonar. Se copia su código real (textos, estilos e imágenes)." },
  { icon: "upload", name: "Sube o arrastra aquí", what: "Elige una captura, un vídeo, un PDF o un SVG y la IA crea la página igual. Los HTML y ZIP se abren tal cual." },
  { icon: "plus", name: "Nuevo clon", what: "Vuelve a la pantalla de inicio para clonar otra cosa. Lo anterior queda guardado en «Tus clones»." },
  { icon: "download", name: "Descargar", what: "Guarda el código del clon en tu dispositivo como archivo ZIP." },
  { icon: "database", name: "Datos", what: "Conecta el proyecto con tu bot de Telegram: lo que la gente envíe en los formularios te llega al chat. También puedes escribir «conecta este proyecto con la base de datos de Telegram» con el token y el ID." },
  { icon: "cloud", name: "Telegram", what: "Envía una copia de seguridad del clon a tu chat de Telegram (se configura en Ajustes)." },
  { icon: "terminal", name: "Ver código", what: "Abre el modo avanzado para ver y editar el código a mano." },
  { icon: "monitor", name: "Ordenador / tablet / móvil", what: "Cambia el tamaño de la vista previa para ver cómo queda en cada pantalla." },
  { icon: "refresh", name: "Recargar", what: "Vuelve a cargar la vista previa desde cero." },
  { icon: "send", name: "Aplicar", what: "Escribe con tus palabras qué quieres cambiar (por ejemplo «pon el botón en verde») y la IA lo hace." },
  { icon: "history", name: "Deshacer", what: "Devuelve el clon a como estaba antes del último cambio." },
];

const TOP: Entry[] = [
  { icon: "bolt", name: "Fácil / Avanzado", what: "Fácil: clonar y pedir cambios. Avanzado: editor de código, historial y herramientas." },
  { icon: "settings", name: "Ajustes", what: "Tu clave de la IA, el modelo, Telegram y las copias automáticas." },
  { icon: "chat", name: "Ayuda (?)", what: "Abre esta guía." },
];

const ADVANCED: Entry[] = [
  { icon: "save", name: "Guardar versión", what: "Guarda una foto del código actual en el historial para poder volver a ella." },
  { icon: "download", name: "Exportar ZIP", what: "Descarga todo el código del proyecto." },
  { icon: "cloud", name: "Sincronizar", what: "Envía una copia del proyecto a Telegram." },
  { icon: "chat", name: "Asistente", what: "Chat con la IA para pedir cambios en el código." },
  { icon: "history", name: "Historial", what: "Todas las versiones guardadas: compara cambios y restaura la que quieras." },
  { icon: "globe", name: "Análisis", what: "Revisa accesibilidad, colores, tipografía y estructura del proyecto." },
  { icon: "image", name: "Visual", what: "Sube capturas o vídeos y genera la interfaz a partir de ellos." },
  { icon: "package", name: "Librerías", what: "Detecta y añade librerías (Tailwind, Bootstrap, iconos…) que el código necesita." },
  { icon: "cloud", name: "Telegram", what: "Copias de seguridad: guardar, ver y restaurar." },
  { icon: "plus", name: "Nuevo proyecto (+)", what: "Crea un proyecto desde una plantilla o una fuente." },
  { icon: "upload", name: "Importar ZIP", what: "Abre un proyecto o una copia descargada." },
];

function Section({ title, items }: { title: string; items: Entry[] }) {
  return (
    <section className="help-section" aria-label={title}>
      <h3 className="section-title">{title}</h3>
      <ul className="help-list">
        {items.map((e) => (
          <li key={e.name}>
            <span className="help-icon" aria-hidden="true">
              <Icon name={e.icon} size={16} />
            </span>
            <span>
              <b>{e.name}</b>
              <span className="muted">{e.what}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function HelpDialog() {
  const open = useStudio((s) => s.helpOpen);
  const setHelpOpen = useStudio((s) => s.setHelpOpen);
  return (
    <Dialog title="¿Para qué sirve cada botón?" open={open} onClose={() => setHelpOpen(false)}>
      <ol className="help-steps">
        <li>Pega un enlace o sube una captura.</li>
        <li>Espera a que aparezca la vista previa.</li>
        <li>Escribe abajo lo que quieras cambiar y pulsa «Aplicar».</li>
      </ol>
      <Section title="Pantalla principal (modo Fácil)" items={EASY} />
      <Section title="Barra superior" items={TOP} />
      <Section title="Modo Avanzado" items={ADVANCED} />
    </Dialog>
  );
}
