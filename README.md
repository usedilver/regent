# regent

## Autenticación

regent ejecuta el binario oficial `claude` con las credenciales del operador. En v2,
`auth.mode: indie` exige exactamente un usuario autorizado y usa su login local;
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
exige un único usuario y rechaza instrucciones de los demás. Para un equipo, usa
`team` con API key. Ver [Consumer Terms, secciones 2 y 12](https://www.anthropic.com/legal/consumer-terms).

El aviso aparece durante la migración y al iniciar el servidor o una consulta por CLI.
Los límites de Pro/Max siguen aplicando; regent no garantiza uso ilimitado ni ausencia
de sanciones. Si `ANTHROPIC_API_KEY` está presente, el CLI puede facturar por API:
revisa su autenticación para usar tu suscripción.

## Uso

regent es un cliente conversacional open source de Claude Code CLI, con Slack como
primera interfaz. El repo predeterminado aporta contexto; cada repo define sus
skills, MCPs, reglas y flujo de trabajo. No requiere Notion ni crear una tarea
para conversar. Consultas y cambios con PR están validados en real; todavía hay
flujos impuestos por el core que deben retirarse. El contrato vigente y los
pendientes están en [docs/v2.md](docs/v2.md).

```sh
pnpm start                 # servidor (Slack), escucha en 127.0.0.1
pnpm dev                   # igual, con recarga al guardar (src/, config/, .env)
pnpm test                  # suite v2
pnpm regent ask "Explica este repositorio" --conversation revision
pnpm regent patch "Corrige el fallo y abre un PR" --conversation correccion
pnpm regent runs
pnpm regent tasks
pnpm regent gates
pnpm regent gate <gate_id> approve
pnpm regent sync
pnpm regent tail <run_id> --follow
```

Cuando Regent necesita una decisión, puede mostrar hasta cinco opciones con botones
en el hilo. También puedes responder con tus propias palabras. La respuesta continúa
la misma conversación; un botón ya respondido o de una pregunta reemplazada no vuelve
a ejecutar trabajo. Elegir una alternativa no reemplaza la aprobación del plan o QA.
En CLI las opciones se muestran como texto. El arranque actualiza SQLite al esquema 4
y conserva las sesiones y preguntas pendientes de versiones anteriores.

Antes de iniciar: copia `regent.example.yaml` a `config/regent.yaml` y completa
`auth.mode`, `slack.workspace_team_id` y `slack.allowed_users`. Necesita
`SLACK_BOT_TOKEN` y `SLACK_APP_TOKEN` de una app con `slack-manifest-v2.json`
(Agent messaging). Define `repos.path` y `repos.default_repo` para el contexto inicial.
Notion/Jira son opcionales y se configuran en el repo mediante sus propias herramientas.

En canales y salas el bot actúa solo con @mención; sin mención acepta únicamente
la respuesta del autor cuando el bot le preguntó algo (o los comandos exactos
`stop`/`para`/`reset`/`nuevo`). En un DM todo se procesa. Al crear una tarea con
sala, la conversación se muda a la sala y conversa a raíz de canal; el hilo de
origen recibe solo el puntero.

`pnpm start` usa `REGENT_PORT=8788`, `REGENT_DB=log/v2.sqlite` y escucha solo en
`127.0.0.1`. `REGENT_CONFIG` permite elegir otro YAML. La CLI y el servidor no deben
ejecutar agentes simultáneamente sobre la misma base: el bloqueo de runtime lo impide.
Para probar la CLI con el servidor activo, usa otra `REGENT_DB`.

El servidor necesita `SLACK_BOT_TOKEN` y `SLACK_APP_TOKEN` de una app con el manifiesto
`slack-manifest-v2.json`. Prueba con una app separada: dos servidores Socket Mode con
el mismo app token pueden repartirse eventos. El manifiesto v2 usa Agent messaging y
suscribe `agent_session_stopped`; la [migración de Slack es irreversible](https://docs.slack.dev/ai/migrating-to-agent-messaging/).
No expongas `/tools`, `/tool-policy` ni `/hook-denial` mediante el túnel. `/healthz` incluye conexión,
cola y entregas pendientes; `/metrics` expone runs por estado.

### Implementación Actual Y Límites

Lo siguiente describe mecanismos existentes, no requisitos del contrato de v2.
Los gates de negocio y las salas ligadas a tareas están pendientes de desacoplar.

El repo aporta MCPs, skills, reglas y variables. El modo de permisos actual es
`bypass` por defecto; no equivale a respetar los `allow/ask/deny` nativos del repo.
`permission_mode: native` permite usar los permisos nativos, pero en ejecución
headless las solicitudes sin autorización pueden denegarse. Los hooks de Regent
no son un sandbox; las credenciales de datos deben tener los permisos adecuados.

Los hooks permiten Edit/Write dentro del worktree propio, y exigen aprobación del
plan cuando hay tarea. Git/gh y los scripts del repo siguen los permisos del runtime,
sin prohibición global de escritura. Crear/clonar no requiere un manifiesto propio;
ver [proyectos y cambio de contexto](docs/projects.md). Los cambios gestionados por
el core aún usan sus helpers de instalación, tests y publicación. Se admiten
MCPs externos; `repos.readonly_mcp` restringe los servidores indicados. Esos
MCPs deben usar credenciales de base de datos de solo lectura: el filtro de comandos
no reemplaza los permisos de la base. `agent_env_files` conserva el contexto del repo.
Node >=22.20 y un Claude Code que soporte `--permission-prompts` son necesarios.

El backlog es del repo, no de regent: si el proyecto define un MCP de Notion, una
skill de backlog o sus propios estados, el agente los usa de forma 100% agéntica.
regent solo registra la tarea localmente y gobierna lo humano: sala, compuertas de
plan/QA con botones, y seguimiento de PRs hasta el merge. Las tareas M/L requieren
plan aprobado; QA se solicita después de publicar todos sus PRs. Un cambio S sin
tarea usa `policy.small_fix` y `track_small_fixes` (`digest`); `fast_track` es
opcional y está desactivado por defecto. Para tests fuera de `package.json`, declara
`repos.test_commands: { mi-repo: ["pytest", "-q"] }` (clave `.` para el repo raíz).
La instalación automática solo admite proyectos Node con lockfile.

El servidor verifica merges cada 60 segundos. Opcionalmente expón **solo**
`POST /webhooks/github` y configura `GITHUB_WEBHOOK_SECRET` para recibir eventos
`pull_request`; el webhook valida firma y deduplica, y el core confirma el merge con
`gh` antes de cerrar la tarea. `pnpm regent sync` revisa las tareas de la CLI;
las compuertas de Slack se responden en Slack.

Un resultado remoto incierto se reconcilia antes de repetir una creación. Si no puede
reconciliarse, se detiene con aviso para revisión operativa; no se garantiza
exactly-once para mensajes de Slack. Las operaciones de trackers externos dependen
de las herramientas configuradas por cada repo.

`REGENT_SMOKE=1 pnpm smoke` prueba una consulta con Claude real y una base temporal;
puede consumir saldo. La suite normal usa procesos falsos y no necesita tokens.
