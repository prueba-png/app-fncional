# Tu servidor de descarga (opcional)

Sirve para que **clonar por enlace** falle mucho menos. Es gratis, sin tarjeta.
**No es obligatorio**: la app funciona sin él.

## La forma más fácil (copiar y pegar, ~5 minutos)

1. Abre **https://dash.cloudflare.com** y crea una cuenta gratis (con tu correo).
2. En el menú de la izquierda: **Workers & Pages**.
3. Botón **Create** → **Create Worker** → **Deploy** (acepta el nombre que salga).
4. Arriba a la derecha: **Edit code**.
5. Borra todo lo que aparezca en el editor y **pega el contenido del archivo
   `worker.js`** (está en esta misma carpeta). Pulsa **Deploy** (arriba a la derecha).
6. Copia la dirección que te da Cloudflare, del tipo:
   `https://devstudio-proxy.TU-USUARIO.workers.dev`
7. En la app: **Ajustes → «Mi servidor de descarga»**, pega esa dirección y **Guardar**.

Listo. A partir de ahí los clones por enlace usan tu servidor.

## Notas
- Solo descarga **páginas públicas**. No sirve para páginas con inicio de sesión
  ni para saltarse protecciones.
- El plan gratuito de Cloudflare da unas 100.000 descargas al día, de sobra.
- Si dejas el campo vacío en Ajustes, la app usa los servicios gratuitos compartidos.
