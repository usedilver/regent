# Imagenes de Slack hacia Claude Code

## Alcance implementado

Regent entrega imagenes como bloques multimodales al CLI oficial (`claude -p
--input-format stream-json`). No llama directamente a la API del modelo ni instala
un OCR. Aplica a archivos de imagen compartidos mediante Slack:

- Imagen adjunta o pegada en el mensaje que invoca al agente.
- Imagen de un mensaje anterior del mismo hilo, aunque sea de otra persona.
- DM con texto e imagen o solo imagen.
- Salas/canales: imagenes de su historial, incluidas respuestas a mensajes antiguos.

En canales e hilos sigue haciendo falta mencionar al agente. Las imagenes no cambian
las reglas de invocacion, acceso al workspace, permisos del repo ni concurrencia.
Una imagen publica incrustada por URL, un unfurl o una captura dentro de un PDF no
equivale a un archivo de imagen de Slack: no esta soportado en esta etapa.

## Flujo y persistencia

1. El lector de historial conserva autor, mensaje, nombre e ID del archivo.
2. `History` guarda esas referencias en el snapshot de SQLite y selecciona las
   imagenes aun no entregadas a la sesion. Prioriza el mensaje actual y las recientes.
3. `files.info` obtiene la URL privada actual. Solo Regent usa el token de Slack
   para descargar desde `https://files.slack.com`, sin seguir redirecciones.
4. El parser `image-size` comprueba formato y dimensiones del contenido; no basta
   con confiar en el MIME de Slack. La validacion de cabecera no es un decodificador
   completo: Claude todavia puede rechazar un archivo corrupto.
5. Los bytes se convierten a base64 en memoria y se envian por stdin junto a etiquetas
   de procedencia. No se incluyen en argumentos de shell, texto del prompt o SQLite.
6. Tras un turno completado, el historial evita reenviar imagenes ya entregadas.
   Imagenes fallidas no se reconocen como entregadas y pueden reintentarse.

Una sesion nueva vuelve a cargar referencias; una reanudacion depende tambien de
los archivos de sesion que administra Claude Code. Cambiar de repo utiliza el
mecanismo existente de nueva sesion/contexto. SQLite no es una copia de seguridad
de los archivos de Slack: si alguien los elimina, una descarga futura puede fallar.
Claude puede conservar imagenes en su propio historial. Considerar esos archivos
datos privados y aplicar la politica de retencion del operador.

## Limites iniciales

- PNG, JPEG, GIF y WebP. GIF animado: solo se debe asumir el primer fotograma.
- Hasta cinco intentos de imagenes distintas por turno.
- Hasta 3 MiB binarios por imagen y 10 MiB binarios en total.
- Hasta 8000 x 8000 pixeles; no hay resize automatico en esta version.
- Diez segundos por archivo para consulta de metadata y descarga; cancelable.
- Bytes limitados durante la lectura, aunque Slack omita o declare mal el tamano.

Un adjunto rechazado genera un aviso; Claude recibe el motivo y la instruccion de
no inventar su contenido. El resto de la consulta puede continuar. El contenido
visual se trata como datos no confiables, nunca como instrucciones de sistema.
No se guardan copias en worktrees ni existe una carpeta temporal de imagenes que
limpiar en Regent. No se resuelven URLs arbitrarias desde texto de usuarios.

## Configuracion y pruebas

La app necesita `files:read` (ya incluido en el manifiesto), acceso a la conversacion
y un CLI que soporte `--input-format stream-json`. Reiniciar Regent tras actualizar.
No hace falta otro webhook, token del modelo ni cambio en los skills del repo.

- `pnpm test`: simulaciones de hilo, DM, canal, descarga, limites, origen, errores,
  snapshots, reinicio, deduplicacion, reintentos y payload real por stdin a un proceso fake.
- `REGENT_SMOKE=1 node test/images-smoke.mjs`: prueba opt-in con Claude real,
  imagen sintetica y reanudacion. Puede consumir uso; no usa datos reales del equipo.
- Verificado localmente: la suite automatizada paso y el CLI real identifico el
  cuadrado rojo sintetico, luego recordo el color al reanudar sin reenviar la imagen.
  El primer intento dentro del sandbox agoto su tiempo; la prueba fuera del sandbox paso.
- Prueba manual pendiente en la app desplegada: compartir una captura con otro
  usuario y mencionar al agente desde una respuesta; repetir pegando la imagen en
  la propia invocacion y en DM. Verificar tambien `stop` durante una descarga.

## Fuentes

- [Slack file object y autorizacion](https://docs.slack.dev/reference/objects/file-object/)
- [Slack: trabajo con archivos](https://docs.slack.dev/messaging/working-with-files/)
- [Claude: entrada streaming con imagenes](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Claude: formatos y limites visuales](https://platform.claude.com/docs/en/build-with-claude/vision)

Los limites de Regent son deliberadamente menores que algunos limites del proveedor;
no deben interpretarse como limites universales de Claude o Slack.
