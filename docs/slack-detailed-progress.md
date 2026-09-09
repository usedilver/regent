# Progreso detallado de herramientas

Estado: propuesta futura, no implementada. Fecha: 2026-09-09.
Relacionado: [progreso Slack](v2-slack-progress.md).

## Objetivo

Permitir al operador inspeccionar comandos Bash y argumentos MCP (incluido SQL)
para detectar desvios y detener el trabajo. No sustituir la operacion real por
una descripcion inventada ni ampliar indefinidamente una lista de comandos.
El modo restringido actual se conserva hasta implementar y validar esta propuesta.

## Configuracion propuesta

- `slack.progress_visibility: restricted | detailed`, predeterminado `restricted`.
- Activacion explicita por el administrador, con advertencia sobre la audiencia
  del canal, retencion de mensajes y limites del enmascarado.
- No permitir activacion mediante prompts, argumentos de herramientas o mensajes
  de usuarios sin autorizacion administrativa.
- Revalidar la politica al trasladar una conversacion a una sala. No copiar
  automaticamente detalles de un DM a un canal con mas participantes.

## Contenido visible

- Bash: comando real multilínea, en formato de codigo y con longitud limitada.
- MCP: nombre y argumentos estructurados; SQL cuando la herramienta lo reciba
  como argumento, JSON para el resto. No asumir un unico nombre de parametro SQL.
- No publicar resultados de herramientas, filas de bases de datos, archivos ni
  razonamiento interno. Agregar resultados requeriria una politica independiente.
- Correlacionar cada detalle con el ID de llamada, no solo con la categoria.
  Mantener limites de mensajes y bloques, paginacion o truncado explicito.
- Publicar al observar la llamada; preservar stop, estados y respuesta final.

## Enmascarado con `****`

Aplicar antes de persistir el snapshot de presentacion y antes de enviarlo a Slack.
Recorrer objetos y arrays; ocultar claves sensibles (tokens, passwords, cookies,
authorization, keys), credenciales en URLs y patrones conocidos de secretos.
Permitir reglas adicionales del operador para datos personales y valores internos.
Para SQL, usar analisis estructurado cuando sea posible: ocultar literales que
puedan contener datos personales, tambien dentro de comentarios. Ante un formato
no interpretable, ocultar el detalle completo en lugar de afirmar que es seguro.
No guardar una copia cruda adicional para renderizado o reintentos.

El reemplazo es literalmente `****`. No basta con cambiar `[REDACTED]` por esa
cadena: el problema principal es detectar lo sensible. Ningun filtro garantiza
eliminar todos los datos privados. Documentar ese riesgo residual expresamente.
Los logs actuales del runtime requieren una auditoria separada; esta propuesta
no garantiza su saneamiento ni modifica retrospectivamente datos existentes.

## Entrega y seguridad

No reenviar el detalle completo por campos acumulativos de appendStream.
Preferir reemplazos idempotentes o un detalle inmutable por llamada; comprobar
visualmente duplicados, reintentos, reconexion, reinicio y cambio de destino.
Reevaluar visibilidad y enmascarado al entregar datos pendientes.

Ver el comando no equivale a aprobarlo antes de ejecutarse: un comando rapido
puede terminar antes de mostrarse. Stop no revierte efectos. Una aprobacion previa
para operaciones sensibles seria una funcionalidad separada, no prometida aqui.

## Criterios de aceptacion

- Fixtures de Bash y MCP/SQL con secretos, PII, URLs, comentarios y formatos raros.
- Ausencia de valores sensibles conocidos en snapshots, payloads y fallbacks.
- Pruebas de limites, correlacion, concurrencia, reintentos y politica de traslado.
- Validacion visual real de codigo multilinea en DM, hilo y sala.
- El modo restringido conserva su comportamiento y sigue siendo el default.
