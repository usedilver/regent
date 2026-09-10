# Adjuntos de Slack: trabajo futuro

## Estado

Imagenes: implementadas segun [slack-images.md](slack-images.md).
Texto: ya se descargan snippets y archivos compatibles, con limite de 200 KiB y
extracto de hasta 12000 caracteres. No es un parser de documentos estructurados.
PDF, Office, audio, video y archivos comprimidos: pendientes. Mostrar el nombre
de un archivo no significa haber leido su contenido.

## Diseno comun

Mantener Regent agnostico. El transporte reconoce formatos, conserva autor/mensaje
y entrega contenido; los repositorios deciden como investigar, transformar o crear
recursos. Reutilizar autenticacion Slack y controles de origen, tamano, cancelacion,
deduplicacion, procedencia y avisos por adjuntos inaccesibles.

Antes de agregar disco: definir directorio privado fuera de repos, permisos 700/600,
cuotas por instancia y turno, limpieza al cerrar, retencion para reinicios y exclusiones
de Git. No permitir que nombres de archivo controlen rutas. SQLite solo debe guardar
referencias/metadatos, no credenciales o grandes blobs.

## PDF

- Investigar soporte de bloques document en el CLI, incluidas sesiones reanudadas.
- Alternativa: extraer texto y renderizar paginas necesarias con una libreria probada.
- Conservar numero de pagina para citas; detectar documentos escaneados o cifrados.
- Limitar bytes, paginas, pixeles, tiempo y cantidad de paginas enviadas al modelo.
- OCR opcional para escaneos; no sustituir indiscriminadamente tablas o graficos por texto.
- Probar texto, escaneo, columnas, tablas, documento vacio, cifrado y corrupto.

## DOCX, XLSX, PPTX y CSV

- Elegir parsers mantenidos; no ejecutar macros, formulas, objetos incrustados ni links.
- Extraer con procedencia: hoja/celda, diapositiva o seccion.
- Distinguir valores y formulas sin recalcular contenido no confiable.
- Limitar hojas, filas, diapositivas y volumen descomprimido; proteger contra zip bombs.
- CSV pequeno ya puede llegar como texto; agregar estructura y truncamiento explicito.

## Audio y video

- Audio necesita una estrategia de transcripcion, idioma, timestamps y consentimiento.
- No asumir que el modelo configurado admite audio nativo ni enviar silenciosamente
  datos a un proveedor adicional. Documentar coste, credenciales y retencion.
- Video: extraccion acotada de fotogramas y audio; evitar descargar duraciones ilimitadas.
- Separar lo observado en imagen de lo dicho en audio y declarar segmentos omitidos.

## ZIP y otros archivos

- No extraer automaticamente archivos arbitrarios.
- Rechazar path traversal, enlaces simbolicos, rutas absolutas y contenido ejecutable.
- Aplicar limites de profundidad, cantidad, ratio de compresion y tamano expandido.
- Presentar inventario antes de procesar paquetes grandes; pedir seleccion al usuario.

## Criterios de cierre por formato

1. Imagen/archivo directo, mensaje anterior de otro autor, DM y sala con respuestas.
2. Invocacion sin texto, varios adjuntos, archivos duplicados y nombres maliciosos.
3. Reinicio, reanudacion, traslado de sala, cambio de repo y cancelacion.
4. Archivo privado, eliminado, sin permisos, enlace externo, MIME incorrecto y corrupcion.
5. Ningun token ni contenido binario en Slack, logs de Regent o Git.
6. Respuesta con procedencia, limites y fallos explicitos; sin afirmar lecturas inexistentes.
7. Prueba automatizada y prueba real opt-in contra Slack/CLI antes de declarar soporte.

Prioridad sugerida: PDF, Office, audio, video y finalmente ZIP. No hay implementacion
de estos formatos incluida en la entrega de imagenes.
