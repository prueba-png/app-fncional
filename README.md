# DevStudio Pro

Entorno de desarrollo **local y privado** para ingeniería inversa de interfaces, prototipado rápido y gestión descentralizada de proyectos.

- **Análisis estructural de UI**: ingesta de URLs públicas (DOM, CSS, assets, accesibilidad) y generación de una réplica estática de estudio.
- **Referencia visual**: capturas, vídeos (extracción de fotogramas), SVG y PDF procesados en el navegador para generar interfaces equivalentes.
- **Asistente de código**: chat con Claude que edita los ficheros del proyecto en tiempo real mediante streaming.
- **Control de versiones local**: cada cambio (manual, IA, análisis, librerías) crea una versión con diff y rollback no destructivo.
- **Vista previa aislada**: iframe `sandbox` sin `allow-same-origin`, con consola integrada y navegación entre páginas.
- **Gestor de dependencias**: detecta Tailwind, Bootstrap, Bulma, Font Awesome, jQuery, Alpine, htmx, GSAP, Chart.js, Google Fonts, etc., y las inyecta desde CDN.
- **Persistencia**: IndexedDB para proyectos, versiones, chat, referencias y ajustes. Exportación a ZIP.
- **Respaldo descentralizado en Telegram**: tu propio bot empaqueta y guarda los proyectos (código + historial + chat + referencias) en tu chat privado, y los restaura bajo demanda.

## Requisitos

- Node.js ≥ 20.10
- (Opcional) Una clave de la API de Anthropic para el asistente
- (Opcional) Un bot de Telegram para las copias de seguridad

## Puesta en marcha

```bash
npm install
cp .env.example .env      # opcional
npm run dev
```

Abre <http://127.0.0.1:5173>. El comando arranca dos procesos:

| Proceso | Dirección | Función |
|---|---|---|
| Vite (React) | `127.0.0.1:5173` | Interfaz, con proxy de `/api` al servidor local |
| Express | `127.0.0.1:8787` | Ingesta de URLs, proxy del asistente y de la Bot API de Telegram |

### Producción local

```bash
npm run build
npm start                 # sirve la app compilada y la API en http://127.0.0.1:8787
```

### Pruebas

```bash
npm test                  # vitest: protocolo de ficheros, dependencias, bundler, SSRF, ingesta, ZIP
npm run typecheck
```

## Configuración

Todo se configura desde **Ajustes** (icono de engranaje). Los valores se guardan solo en el IndexedDB de tu navegador.

### Asistente (API de Anthropic)

Introduce tu clave (o define `ANTHROPIC_API_KEY` en `.env`) y elige modelo y nivel de esfuerzo. Por defecto se usa `claude-opus-5-5` con pensamiento adaptativo y reintento automático ante rechazos (`fallbacks: "default"`).

El modelo recibe los ficheros actuales y devuelve los que modifica con este protocolo, que el editor aplica y versiona:

```text
<file path="index.html">
…contenido completo…
</file>
<delete path="obsoleto.css" />
```

Las respuestas truncadas o incompletas nunca se aplican a medias. Cada respuesta que modifica ficheros crea una versión y se puede **revertir** desde el propio chat.

### Telegram

1. Crea un bot con **@BotFather** (`/newbot`) y copia el token.
2. Escribe un mensaje a tu bot, o añádelo como administrador a un grupo o canal privado.
3. Obtén el Chat ID (por ejemplo, con **@userinfobot**; los canales empiezan por `-100`).
4. Pulsa **Probar conexión** en Ajustes: el bot enviará un mensaje de confirmación.

Desde la pestaña **Telegram** puedes respaldar el proyecto activo o todos, restaurar desde el registro local o por `file_id`, y activar copias automáticas periódicas. Los ZIP también se pueden descargar desde Telegram e importar con **Importar ZIP** en la barra lateral.

Límites de la Bot API: 50 MB por subida y 20 MB por descarga. Si necesitas más, ejecuta tu propio [servidor Bot API](https://github.com/tdlib/telegram-bot-api) y define `TELEGRAM_API_URL`.

## Arquitectura

```text
shared/                 Código común cliente/servidor
  types.ts              Tipos de dominio
  dependencies.ts       Detección de librerías y etiquetas CDN
  fileBlocks.ts         Protocolo <file>/<delete> del asistente
server/                 Servidor local (Express 5, solo 127.0.0.1)
  index.ts              Arranque y protecciones (Host, Origin, cabecera x-devstudio)
  lib/safeFetch.ts      Descarga con protección SSRF, límites de tamaño y tiempo
  lib/domAnalyzer.ts    Motor de análisis DOM, accesibilidad y réplica de estudio
  lib/cssAnalyzer.ts    Paleta, tipografía, variables, breakpoints
  lib/prompts.ts        Instrucciones del asistente
  routes/ingest.ts      POST /api/ingest
  routes/llm.ts         POST /api/llm/chat (SSE)
  routes/telegram.ts    POST /api/telegram/{test,backup,restore}
src/                    Cliente (React 19 + Vite + zustand + CodeMirror 6)
  db/db.ts              Esquema IndexedDB
  store/studio.ts       Proyectos, ficheros, versiones, ajustes
  store/chat.ts         Conversación, streaming y aplicación de cambios
  lib/bundle.ts         Construcción del documento de la vista previa
  lib/media.ts          Imágenes, fotogramas de vídeo, paletas, SVG, PDF
  lib/zip.ts            Exportación, paquetes de respaldo e importación
  lib/backup.ts         Sincronización con Telegram
  components/           Interfaz
tests/                  Pruebas (vitest)
```

## Seguridad y privacidad

- El servidor solo escucha en `127.0.0.1` y rechaza peticiones con `Host`/`Origin` no locales o sin la cabecera `x-devstudio` (protege frente a CSRF y DNS rebinding).
- La ingesta de URLs bloquea destinos privados y de loopback, y revalida cada redirección. Para analizar tus propios servidores locales define `ALLOW_PRIVATE_URLS=true`.
- La réplica elimina scripts, manejadores `on*` y metaetiquetas CSP/refresh por defecto. La vista previa se ejecuta en un origen opaco sin acceso al almacenamiento del editor.
- Las claves y el token del bot se guardan en el IndexedDB del navegador y solo viajan a tu servidor local. El servidor no los persiste y los elimina de los mensajes de error.
- Usa la ingesta de URLs solo con páginas que tengas derecho a analizar. Respeta los derechos de autor y los términos de uso de cada sitio.

## Atajos

| Atajo | Acción |
|---|---|
| `Ctrl/Cmd + S` | Guardar versión |
| `Enter` / `Shift + Enter` | Enviar / nueva línea en el chat |
| Doble clic en una pestaña | Renombrar fichero |

## Licencia

MIT
