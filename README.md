# regent

## Autenticación

regent ejecuta el binario oficial `claude` con las credenciales del operador. En v2,
`auth.mode: indie` usa su login local y recomienda un unico usuario autorizado;
`auth.mode: team` exige `ANTHROPIC_API_KEY`. regent no ofrece un login de Claude ni
extrae tokens OAuth. Revisa los [términos actuales de Claude Code](https://code.claude.com/docs/en/legal-and-compliance)
para tu modalidad de uso; la guardia de arranque valida la configuración, no sustituye esos términos.

### Individual Con Pro/Max

`indie` usa tu propio login en el binario oficial Claude Code y **no requiere API key**.
Inicia sesión con tu cuenta desde el CLI de Claude en la máquina del servidor y configura:

```yaml
auth:
  mode: indie
slack:
  workspace_team_id: TU_WORKSPACE_ID
  allowed_users: [TU_ID_DE_SLACK]
```

**Advertencia:** compartir tu cuenta o permitir que otras personas usen tu suscripción
mediante el bot puede incumplir los términos de Anthropic y provocar suspensión o
cancelación del acceso (baneo). La advertencia no autoriza el uso compartido: `indie`
advierte si hay varios usuarios o acceso abierto, pero no bloquea el arranque. Para un equipo, usa
`team` con API key. Ver [Consumer Terms, secciones 2 y 12](https://www.anthropic.com/legal/consumer-terms).

El arranque individual con exactamente un usuario muestra solo una linea informativa.
La advertencia de uso compartido aparece si la lista esta vacia o contiene varios
usuarios; el servidor continua, sin que esto constituya autorizacion del proveedor.
`allowed_users: []` permite usuarios activos del workspace verificados por Slack;
los bots siguen excluidos. Una lista explicita restringe el acceso a esos IDs.
Si hay una API key en modo individual,
se mantiene el aviso independiente sobre posible facturacion API.
Los límites de Pro/Max siguen aplicando; regent no garantiza uso ilimitado ni ausencia
de sanciones. Si `ANTHROPIC_API_KEY` está presente, el CLI puede facturar por API:
revisa su autenticación para usar tu suscripción.

## Uso

regent es un cliente conversacional open source de Claude Code CLI, con Slack como
primera interfaz. El repo predeterminado aporta contexto; cada repo define sus
skills, MCPs, reglas y flujo de trabajo. No requiere Notion ni crear una tarea
para conversar. El flujo de desarrollo pertenece al repo, sin tareas, planes ni
gates de Regent. El aislamiento Git por conversación sí es obligatorio. El contrato
vigente y los pendientes están en Notion (proyecto **regent**, cuenta Dilver).

```sh
pnpm regent setup --repo /ruta/a/repos/proyecto --team T012345 --user U012345
pnpm start                 # servidor (Slack), escucha en 127.0.0.1
pnpm dev                   # igual, con recarga al guardar (src/, config/, .env)
pnpm test                  # suite automatizada
pnpm regent ask "Explica este repositorio" --conversation revision
pnpm regent ask "Revisa este proyecto" --repo otro-repo --conversation otra-revision
pnpm regent patch "Corrige el fallo y abre un PR" --conversation correccion
pnpm regent runs
pnpm regent tail <run_id> --follow
```

Cuando Regent necesita una decisión, puede mostrar hasta cinco opciones con botones
en el hilo. También puedes responder con tus propias palabras. La respuesta continúa
la misma conversación; un botón ya respondido o de una pregunta reemplazada no vuelve
a ejecutar trabajo. El significado de una aprobación lo determina la pregunta y el
flujo del repo, no una compuerta propia de Regent.
En CLI las opciones se muestran como texto. El arranque actualiza SQLite al esquema 9
y conserva las sesiones y preguntas pendientes de versiones anteriores.

El setup crea `config/regent.yaml` (o `REGENT_CONFIG`) sin sobrescribir archivos
existentes ni abrir la base de sesiones. Solo guarda modo, permisos, workspace,
repo predeterminado e IDs de Slack. El workspace por defecto es la carpeta padre
del repo; usa `--workspace /ruta/a/Projects` para permitir otros proyectos dentro
de esa carpeta. Puedes repetir `--user`; en `indie`, varios usuarios muestran una advertencia.
`--permissions native` aplica permisos nativos; el valor por defecto `bypass` no
aplica `allow/ask/deny`. No guarda secretos ni valida conexiones externas.
También puedes copiar [config/regent.example.yaml](config/regent.example.yaml) a
`config/regent.yaml` manualmente. La [guía de configuración](config/README.md)
explica los campos activos, valores predeterminados y opciones retiradas.
Antes de iniciar necesita
`SLACK_BOT_TOKEN` y `SLACK_APP_TOKEN` de una app con `slack-manifest.json`
(Agent messaging). Define `repos.path` y `repos.default_repo` para el contexto inicial.
Notion/Jira son opcionales y se configuran en el repo mediante sus propias herramientas.

Para elegir un repo directamente al iniciar un hilo o DM nuevo, puedes escribir:

```text
@Regent
repo: ruta/relativa/al/workspace
Revisa este bug y explícame la causa.
```

También admite rutas absolutas dentro del workspace y nombres con espacios.
En CLI el equivalente es `--repo <ruta>`. Una ruta inválida no crea una sesión
ni cae silenciosamente al repo predeterminado. Sin selector se conserva el repo
actual o, en una conversación nueva, el predeterminado. La sintaxis es opcional:
puedes seguir describiendo proyectos y URLs normalmente; el agente los interpreta
usando el contexto del repo. En una conversación existente, un selector diferente
se entrega al agente como instrucción de cambio mediante `regent_use_repo`, con
handoff y sesión nueva; no cambia el cwd de un proceso en marcha.

En canales y salas el bot actúa solo con @mención; sin mención acepta únicamente
la respuesta del autor cuando el bot le preguntó algo (o los comandos exactos
`stop`/`para`/`reset`/`nuevo`). En un DM no hace falta mencionar al agente: cada
mensaje raíz inicia una conversación independiente y las respuestas dentro de ese
hilo conservan su repo, sesión y worktree. Para continuar o detener un trabajo,
responde en su hilo; otro mensaje raíz no hereda el proyecto anterior.
Las salas creadas por Regent mantienen contexto compartido de todo su canal.
En cada intervención se
incorporan los mensajes nuevos o modificados del hilo; en conversaciones a raíz
de canal, también sus hilos. Capturas y mensajes entregados se guardan en SQLite
para deduplicar entre turnos y reinicios. Las salas se crean solo cuando se piden,
sin tarea ni tracker. Por ejemplo: «Crea una sala para continuar esto e invita a @Ana».
Regent crea un canal privado, invita al solicitante y a las personas indicadas, y
traslada la misma sesión, repo y worktree. Deja un enlace en el origen y un resumen
en la sala. Los reintentos reutilizan el canal preparado; si falla una invitación,
el traslado queda pendiente en el origen. En la sala sigue aplicando la @mención
y la autorización configurada: ser invitado no amplía `slack.allowed_users`.

El indicador nativo de trabajo se usa cuando Slack confirma el estado del hilo.
Las respuestas finales y avisos normalizan enlaces de correo para mostrar la
direccion sin el prefijo `mailto:`; este se conserva en el destino del enlace.
Tambien se etiquetan explicitamente los correos planos: la conversion Markdown
de Slack puede generar enlaces sin etiqueta y mostrar el esquema `mailto:`.
Los ejemplos de codigo permanecen literales. El texto provisional del stream
no se normaliza hasta reemplazarlo por la respuesta final.
Las salas actuales son canales privados normales: en su raíz se muestra un único
mensaje de progreso que se actualiza, igual que cuando falla el indicador nativo.
Su identificador queda en SQLite para limpiar avisos pendientes tras un reinicio.
Slack también tiene canales de sesión con indicador a nivel de canal; Regent no
crea ese tipo de canal actualmente. Ver [estados de sesión de Slack](https://docs.slack.dev/reference/methods/agents.sessions.setStatus/).

Cada turno reserva para responder el menor valor entre 60 segundos y el 20% de su
límite total. Durante ese margen no inicia nuevas herramientas de investigación o
edición; puede comunicar estado, preguntar, cancelar y recoger o detener subagentes
existentes. El agente recibe el plazo y una instrucción de cierre, y Slack recibe
un aviso. El timeout total no se amplía. Si aun así se interrumpe, se muestra el
texto parcial disponible como incompleto; si no existe, se indica expresamente.
Una herramienta ya en curso puede consumir todo el margen: no se garantiza un
resumen ni se reanuda automáticamente la investigación.

`pnpm start` usa `REGENT_PORT=8788`, `REGENT_DB=log/v2.sqlite` y escucha solo en
`127.0.0.1`. `REGENT_CONFIG` permite elegir otro YAML. La CLI y el servidor no deben
ejecutar agentes simultáneamente sobre la misma base: el bloqueo de runtime lo impide.
Para probar la CLI con el servidor activo, usa otra `REGENT_DB`.

El servidor necesita `SLACK_BOT_TOKEN` y `SLACK_APP_TOKEN` de una app con el manifiesto
`slack-manifest.json`. Prueba con una app separada: dos servidores Socket Mode con
el mismo app token pueden repartirse eventos. El manifiesto v2 usa Agent messaging y
suscribe `agent_session_stopped`; la [migración de Slack es irreversible](https://docs.slack.dev/ai/migrating-to-agent-messaging/).
No expongas `/tools`, `/tool-policy` ni `/hook-denial` mediante el túnel. `/healthz` incluye conexión,
cola y entregas pendientes; `/metrics` expone runs por estado.

### Ejecución Y Permisos

El repo aporta MCPs, skills, reglas y variables. Regent no incluye skills de
planificación, implementación o QA. Su MCP interno ofrece únicamente selección
de repo, salas, progreso, preguntas y cancelación; git/gh, tests, instalación, PRs y
trackers se ejecutan con las herramientas del proyecto.

El modo actual es `bypass` por defecto: no aplica los permisos nativos
`allow/ask/deny`. `permission_mode: native` los respeta sin preautorizar
Edit/Write; las solicitudes sin autorización pueden denegarse en headless.
Ambos modos conservan autorización del run, filtros de credenciales, MCPs marcados
en `repos.readonly_mcp` y validación de rutas de edición dentro del worktree propio.
Los hooks no son un sandbox para comandos de shell.

Cada conversación Git arranca con `claude --worktree` y un nombre estable por
repo/conversación. No se concede acceso adicional a todo el workspace. Dos hilos
tienen directorios y ramas distintos; los mensajes del mismo hilo siguen en cola.
El checkout original aporta contexto, no es el destino de edición. Para modificar
un submódulo, se selecciona su repo de origen y se abre su propio aislamiento.
Sin worktree válido se bloquean edición y comandos, sin fallback al checkout común.

No hay tareas locales nuevas, gates de plan/QA, digest ni seguimiento automático
de merges. Se retiraron `tasks`, `gates`, `gate` y `sync` de la CLI y el webhook
de GitHub. Las opciones antiguas de `policy` y otros campos sin uso se rechazan;
consulta la [guía de migración](config/README.md#removed-inactive-fields).
Las tablas históricas permanecen en SQLite, sin ejecutar su flujo anterior.

Node >=22.20 y Claude Code >=2.1.263 son necesarios para este aislamiento.
Las operaciones remotas y su recuperación dependen de las herramientas del repo;
Regent no garantiza exactly-once para mensajes de Slack.

`REGENT_SMOKE=1 pnpm smoke` prueba una consulta con Claude real y una base temporal;
puede consumir saldo. La suite normal usa procesos falsos y no necesita tokens.
