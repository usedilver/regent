# Migracion del progreso visual de Slack

Fecha: 2026-09-08. Estado: primera implementacion entregada; validacion visual
del flujo completo con Claude pendiente.
Contrato principal: [Regent v2](v2.md).

## Implementacion entregada

Bash: `command-display.ts` permite mostrar un vocabulario exacto de comandos
publicos (`pnpm test`, `npm run build`, `git diff --stat`, etc.). Se muestra el
comando en el titulo durante streaming y en los detalles finales. Si hay argumentos
o operadores, shell-quote identifica exclusivamente la primera operacion de una
lista conocida (incluye `gh repo view`, `which vercel`, `vercel ls`): se publica
su nombre con `[argumentos y resto ocultos]`, nunca los valores originales.
Variables, sustituciones, saltos de linea y scripts arbitrarios siguen opacos;
cualquier operacion desconocida conserva Bash. No se resume toda una cadena.
Validado contra los tres comandos del turno reportado que antes mostraba solo Bash.
Solo el comando validado entra al snapshot de progreso; no se usa la descripcion
libre de Bash. Esta lista controla presentacion, nunca permisos de ejecucion.

Actualizacion tras prueba visual: `auto` ahora utiliza tarjetas `timeline`, no
el plan agrupado. En salas y al cerrar se publican bloques `task_card`. Los
titulos incluyen la herramienta activa; los detalles finales listan hasta ocho
nombres por categoria, validados y sin argumentos ni resultados de herramientas.
Los registros anteriores sin nombre siguen mostrando su categoria.

Corregido el contador concatenado: `task_update` solo envia ID, titulo y estado.
No se reenvian snapshots por `output` o `details`, ya que se acumulan durante el
stream. Los contadores finales se escriben mediante `chat.update`, que reemplaza
el contenido. Las tarjetas siguen agrupadas por categoria para evitar cientos
de bloques; no representan pasos de negocio inferidos. La apariencia es nativa
de Slack. El comportamiento anterior descrito abajo queda como referencia.

- `src/activities.ts`: correlacion por ID y padre, deduplicacion y agrupacion de
  llamadas observadas. No publica inputs, comandos, rutas, resultados ni thinking.
  Una llamada completada no afirma que el objetivo de negocio este verificado.
- `src/slack-activities.ts`: un mensaje de actividades por turno. En hilos/DM usa
  `task_update` con `task_display_mode: plan`; en salas sin hilo usa `plan` con
  `chat.postMessage`/`chat.update`. El indicador y stop nativos se conservan.
  El texto del indicador nativo no cambia: lo dinamico vive en el plan adicional.
- La respuesta Markdown mantiene su propio mensaje/stream; no reemplaza el plan.
  Se agrupa por lectura, edicion, comandos, delegacion, skills y herramientas
  externas, no por nombres de proyectos ni tickets. Sin herramientas no hay plan.
- SQLite v8 agrega `activity_progress`: snapshot seguro, revision, destino,
  timestamp y estado de entrega. Reinicios reintentan snapshots pendientes y
  cierran actividades de turnos terminados. Tras mover la conversacion se cierra
  el mensaje anterior y se publica en el destino, sin herramientas ejecutadas otra vez.
- Actualizaciones agrupadas (minimo 3 segundos por turno), recuperacion cada
  5 segundos y reintento con Retry-After. Formato no disponible degrada a bloques
  y luego texto simple. `slack.progress_mode: plain` fuerza el formato sencillo.
- Las llamadas en background no se dan por completadas al lanzarse. Si no llega
  confirmacion correlacionada, al cerrar quedan como "sin confirmar". No se
  implementa aun seguimiento independiente posterior al fin del turno.
- Se limita a 2000 llamadas seguidas por turno y siete grupos visuales. No hay
  garantia exactly-once si Slack acepta una publicacion y se pierde su respuesta
  antes de guardar el timestamp. Los errores de red mantienen entrega pendiente.

### Verificacion

`test/activities.test.mjs` cubre correlacion, privacidad, duplicados, streams,
salas, interrupcion, recuperacion del adaptador, fallback y traslado.
Se ejecuta con `pnpm test` junto con las suites existentes.

Prueba real en DM del workspace: `chat.startStream`, `chat.appendStream`,
`chat.stopStream` y `chat.update` con el plan fueron aceptados por Slack.
Script opt-in: `REGENT_SLACK_SMOKE_USER=U_ID node test/smoke-slack-progress.mjs`.
Solo envia datos sinteticos a un usuario autorizado; no ejecuta Claude.
No necesita `conversations.open` ni ampliar scopes para abrir el DM.

Pendiente: inspeccion visual desktop/mobile y flujo real Claude en hilo y sala,
incluyendo stop y traslado durante una llamada. La aceptacion HTTP no sustituye
esa inspeccion. Las secciones siguientes conservan el diseno de referencia;
checklists de la propuesta no constituyen pruebas ya ejecutadas.

## Objetivo y alcance

Reemplazar el feedback basado solo en un indicador generico por un mensaje con
acciones observables, estados y resultados breves. La primera captura aportada
por el usuario corresponde a tarjetas de tareas; la segunda, a una lista agrupada
de tareas. No es necesario volver a la API legacy de estados personalizados.

Esta es una migracion de presentacion y entrega, no de la logica del agente.
Regent sigue siendo agnostico: sin tareas obligatorias en Notion/Jira, sin planes
de aprobacion obligatorios, sin cambiar skills, permisos ni repositorios.
Una tarea visual representa una actividad del turno, no un ticket de negocio.
No se expone razonamiento privado del modelo: solo acciones y resultados seguros.

## Capacidades verificadas

La guia distingue indicadores de carga, streaming y visualizacion de tareas.
Algunas funciones AI requieren un plan de Slack de pago; habilitar una opcion en
la app no confirma su disponibilidad. Debe verificarse en el workspace objetivo.
[Guia oficial](https://docs.slack.dev/ai/developing-agents/#loading-states).

`chat.startStream` acepta `task_display_mode: timeline | plan` y chunks de texto,
tarea y titulo de plan. No combinar `markdown_text` y `chunks` en una peticion.
En canales exige destinatario y equipo. Sin `thread_ts`, el streaming solo esta
soportado donde el canal entero sea una sesion, no en cualquier canal privado.
La referencia indica Tier 2 y limites de contenido que deben validarse antes de
enviar. [Referencia de inicio](https://docs.slack.dev/reference/methods/chat.startStream/).

`task_card` representa una accion con `task_id`, titulo y estado; admite detalles,
resultado rich text y fuentes. `block_id` cambia entre revisiones del mensaje.
[Task card](https://docs.slack.dev/reference/block-kit/blocks/task-card-block/).

`plan` agrupa tareas con IDs unicos, hasta 50. El titulo es configurable: usaremos
"Progreso" o "Trabajo completado", no "Thinking completed".
[Plan block](https://docs.slack.dev/reference/block-kit/blocks/plan-block/).

Mantener `agents.sessions.setStatus` para el ciclo de vida y el control de parada.
No asumir que la tarjeta elimina u oculta el indicador nativo. Finalizar con
`active`, o `suspended` cuando se espera al humano.
[Estado de sesion](https://docs.slack.dev/reference/methods/agents.sessions.setStatus/).

## Contratos que requieren un spike

La guia y las referencias consultadas no coinciden en todos los ejemplos:

- La guia muestra `task: { task_id: ... }`; el SDK instalado usa chunks planos
  con `id`, `title`, `status`, `details` y `output` de texto.
- El chunk de texto del SDK usa `text`; ejemplos de la guia usan `markdown_text`.
- La guia alterna `completed` con `complete`; no enviar esos valores indistintamente.
- `pending` figura en el SDK y en un ejemplo de plan, pero no en la lista de
  estados de task card. No usarlo en tarjetas hasta comprobarlo.
- Los ejemplos de la guia usan `message_ts` en ciertos endpoints; verificar los
  argumentos `ts` contra las referencias de cada metodo.
- La guia limita blocks al cierre, mientras la referencia y los tipos actuales
  admiten chunks `blocks`. No mezclar ejemplos de distintas generaciones.

Inspeccion local: Bolt 5.0.0, web-api 8.1.1, types 3.1.0.
`@slack/types/dist/chunk.d.ts` ya define los chunks necesarios. No hace falta
actualizar dependencias a ciegas; confirmar contrato con peticiones reales minimas.
Referencias: [appendStream](https://docs.slack.dev/reference/methods/chat.appendStream/),
[stopStream](https://docs.slack.dev/reference/methods/chat.stopStream/).

Payload candidato basado en los tipos instalados, NO certificado contra Slack:

```json
{
  "channel": "C_TEST",
  "thread_ts": "TEST_THREAD_TS",
  "recipient_user_id": "U_TEST",
  "recipient_team_id": "T_TEST",
  "task_display_mode": "plan",
  "chunks": [
    { "type": "plan_update", "title": "Progreso" },
    { "type": "task_update", "id": "run:tool:1", "title": "Revisando archivos", "status": "in_progress" }
  ]
}
```

El spike debe guardar fixtures sanitizadas de request/response y capturas desktop
y movil: inicio, actualizacion del mismo ID, error, cierre y mensaje final.
Comprobar permisos, membresia, disponibilidad, limites efectivos y visibilidad
para otro miembro del hilo; no asumirla a partir de la vista del solicitante.

## Estado actual del codigo

| Modulo | Comportamiento actual | Cambio necesario |
| --- | --- | --- |
| `src/runner.ts` | Emite tool_use sin ID; tool_result si conserva tool_use_id | Conservar identidad y parentesco para correlacionar |
| `src/core.ts` | Guarda eventos, recuerda lastTool y publica deltas | Reducir eventos a actividades y estados verificables |
| `src/progress.ts` | Texto generico por nombre de herramienta | Reutilizar como fallback; no confundir nombre con resultado |
| `src/types.ts` | Output con texto/progreso y estados | Evento de actividad independiente de Slack |
| `src/slack.ts` | Stream de markdown, mapa de streams en memoria | Renderer de chunks/blocks, snapshots y cierre coherente |
| `src/delivery.ts` | Resultado/avisos durables; progreso best effort | Persistir revision y destino del progreso estructurado |
| `src/store.ts` | slack_progress guarda run/channel/ts | Migracion aditiva para actividades, revision y stream |

Dos restricciones relevantes del codigo existente:

1. `refreshProgress` omite progreso cuando hay animacion nativa. Separar la
   capacidad de animar de la capacidad de presentar actividades.
2. `finishReply` cierra el stream y lo sobrescribe con texto final via chat.update.
   Eso puede borrar el progreso enriquecido. El nuevo cierre debe preservar un
   snapshot terminal y una unica respuesta autoritativa, no concatenar todas las
   respuestas intermedias de Claude como si fueran el resultado final.

## Experiencia propuesta

Por defecto, un plan compacto por turno con varias actividades. Para una accion
aislada, tarjeta individual. Una pregunta inmediata puede responder sin tarjeta;
no inventar una lista de pasos para toda consulta.

Ejemplo ilustrativo, NO flujo obligatorio de Regent:

```text
Progreso
  Repositorio preparado       Completado
  Dependencias instaladas     Completado
  Verificando la aplicacion   En curso

Resultado final: enlace y verificaciones, o bloqueo concreto.
```

Las actividades se agregan cuando se observan, no por un guion fijo. Una llamada
de herramienta completada no demuestra que la aplicacion funciona. Un deploy
aceptado tampoco demuestra acceso, persistencia ni verificacion visual.
Reintentos actualizan la actividad correspondiente; no generan una cascada de
mensajes de fallo. Un error no resuelto queda visible y se explica en el resultado.

## Hilos, DM y salas

| Superficie | Transporte propuesto | Alternativa |
| --- | --- | --- |
| Hilo de canal normal | Stream con thread_ts y chunks | Mensaje unico actualizado |
| DM | Mantener el ancla actual al mensaje del usuario | Mensaje unico actualizado |
| Sala privada normal, raiz | postMessage/update con plan o task_card, si lo admite | Texto compacto actualizado |
| Hilo dentro de una sala | Stream anclado al hilo | Mensaje unico actualizado |
| Canal especial de sesion | Streaming sin hilo si se incorpora y valida | Fuera del alcance inicial |

No convertir salas normales en session channels ni crear hilos artificiales solo
para obtener una animacion. El renderer no cambia donde el agente escucha.
El soporte de bloques enriquecidos en la raiz de nuestras salas requiere prueba;
no prometer paridad visual hasta verla. Siempre incluir texto accesible/fallback.

## Eventos y seguridad

Contrato interno propuesto: `runId`, `activityId`, `parentId?`, `revision`, `title`,
`state`, `summary?`, `sources?`. Estados internos: running, succeeded, failed,
waiting, interrupted. Mapear a los estados soportados por cada renderer; no enviar
valores internos arbitrarios a Slack. Esperas/interrupciones pueden usar texto
terminal sin spinner si la API no tiene estado equivalente.

- ID estable basado en run + tool_use_id, con parentesco de subagentes. No usar
  solo el nombre: puede haber dos consultas simultaneas con resultados distintos.
- Correlacionar tool_result con la llamada, incluso eventos repetidos o tardios.
- Tratar comandos en background como iniciados, no completados, hasta tener evidencia.
- Agrupar lecturas repetidas en una actividad compacta sin perder la trazabilidad.
- Titulos mediante categorias genericas y parametros permitidos. No ejecutar
  comandos para etiquetarlos ni inferir exito solo de una frase del modelo.
- No publicar prompts, thinking, SQL, cuerpos MCP, stdout completo, variables,
  tokens, rutas de credenciales o datos personales. Redactar antes de persistir
  el snapshot publico, no solo antes de enviarlo.
- Enlaces solo de resultados verificados y autorizados para la audiencia; excluir
  URLs firmadas o con secretos. No ampliar acceso mediante fuentes o previews.

## Entrega y recuperacion

Propuesta: persistir snapshot publico por actividad y referencia de presentacion
por run/destino: channel, thread, message_ts, modo, revision deseada/confirmada y
estado del stream. Disenar la migracion contra el schema vigente al implementar;
no reservar ahora un numero de version ni modificar sesiones existentes.

Serializar envios por run, agrupar cambios y limitar frecuencia por workspace.
Respetar Retry-After; coalescer revisiones intermedias, conservar el estado final.
No bloquear la ejecucion de Claude si falla la presentacion. No reintentar errores
de contrato/permisos como si fueran fallos transitorios de red.

Un timeout tras publicar puede ocultar un exito remoto: no prometer exactly-once.
Persistir el ts en cuanto se conoce, reconciliar cuando sea posible y evitar
reproducir a ciegas todo el stream. Preferir restaurar un snapshot sobre volver a
enviar deltas; identificar explicitamente el caso donde no se pudo recuperar el ID.

Al reiniciar, cerrar o sustituir indicadores obsoletos por estado interrumpido.
No reanudar trabajo automaticamente por recuperar la UI. En traslado a sala,
congelar/cerrar origen, incrementar revision de destino y reconstruir alli el
snapshot. Una entrega atrasada no debe devolver progreso al hilo anterior.
Al continuar, crear un nuevo turno visual enlazado al anterior; no reabrir un
stream cerrado ni marcar el turno interrumpido como exitoso.

## Fases y commits propuestos

- [ ] 1. Spike de capacidades y fixtures reales, sin datos sensibles ni recursos externos.
- [ ] 2. IDs del runner y reducer de actividades, pruebas de correlacion y redaccion.
- [ ] 3. Persistencia aditiva y cola de snapshots, recuperacion y traslado.
- [ ] 4. Renderer Slack plan/timeline y fallback de salas; conservar respuesta final.
- [ ] 5. Integracion de espera, cancelacion, timeout y cierre; quitar avisos redundantes.
- [ ] 6. Prueba end-to-end y activacion gradual; actualizar este documento y v2.md.

Proponer un flag de operador `slack.progress_mode: auto | plain`, no configuracion
por repositorio. Durante el spike mantener plain; despues activar auto solo con
fallback probado. Rollback a plain sin revertir DB ni tocar sesiones/worktrees.
No incluir feedback buttons, redisenar toda la respuesta Markdown ni migrar la
arquitectura de canales en este cambio. Esos trabajos se evaluan por separado.

## Pruebas de aceptacion

- [ ] Consulta breve sin herramientas: respuesta directa sin plan ficticio.
- [ ] Herramientas repetidas/paralelas y subagentes: IDs y resultados correctos.
- [ ] MCP/CLI falla y luego se recupera: progreso fiel, sin spam ni falso exito.
- [ ] Pregunta al humano, stop y limite de tiempo: nada queda animando indefinidamente.
- [ ] Texto final distinto de deltas: una respuesta autoritativa, sin borrar actividades.
- [ ] Dos personas en conversaciones distintas: no comparten mensajes ni fuentes.
- [ ] Hilo, DM, raiz de sala e hilo de sala: desktop/movil y segundo participante.
- [ ] Traslado y cambio de repo durante ejecucion: continuidad sin envios al destino viejo.
- [ ] Corte de Slack, rate limit y respuesta perdida tras envio: recuperacion acotada.
- [ ] Reinicio antes/despues de persistir ts y antes/despues del cierre: sin replay masivo.
- [ ] Feature no disponible o permiso insuficiente: fallback legible, ejecucion intacta.
- [ ] Secretos partidos entre deltas y URLs sensibles: no aparecen en tarjeta ni snapshot.
- [ ] Mas actividades que el limite: agrupacion/paginacion sin perder resultado final.
- [ ] Rollback a plain con mensajes enriquecidos ya existentes.

Registrar contadores de fallos/fallback, pendientes y latencia de presentacion sin
payloads privados. Cierre del trabajo: fixtures reales, suite automatizada verde,
pruebas visuales y de recuperacion, documentacion alineada. Este documento por si
solo no certifica disponibilidad ni funcionamiento en el workspace.
