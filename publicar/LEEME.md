# DevStudio Pro en un solo archivo

`index.html` contiene la aplicación completa (interfaz, estilos y código). No necesita servidor ni instalación.

## Enlace publicado

https://prueba-png.github.io/app-fncional/ (rama `gh-pages`, publicada con GitHub Pages).

## Cómo publicarla en otro sitio

Sube `index.html` a cualquier alojamiento de páginas estáticas, por ejemplo:

- **Netlify Drop**: https://app.netlify.com/drop → arrastra o selecciona el archivo.
- **tiiny.host**: https://tiiny.host → sube el archivo y elige un nombre.

También puedes abrirla directamente en el navegador del ordenador (doble clic).

## Qué necesita

- **Clave de la IA de Anthropic** (para clonar capturas, vídeos y webs, y para pedir cambios): créala en https://console.anthropic.com (API Keys) y añade saldo en Billing. La app te la pide la primera vez y la guarda solo en tu navegador.
- **Telegram** (opcional): token del bot y Chat ID en Ajustes.

## Diferencias con la versión con servidor

- Clonar por enlace descarga el código real de la web (HTML y CSS) a través de servicios públicos de reenvío (allorigins, codetabs, corsproxy). Si ninguno responde, la IA reconstruye la página a partir de su contenido.
- En el modo avanzado, «Análisis» funciona sobre el proyecto abierto; descargar y analizar una URL directamente necesita el servidor (`npm run dev`).

Se regenera con `npm run build:standalone`.
