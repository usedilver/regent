# regent

Pipeline de backlog **Notion → agentes** que corre en tu máquina con tu suscripción de Claude. Cuando un card entra a una columna con trigger, un agente ejecuta la fase (planificar, implementar), escribe el resultado en el card y lo mueve a la siguiente compuerta humana.

**El harness es Claude Code.** Cada capa sale de su dueño natural:

| Capa | De dónde sale |
|---|---|
| CLAUDE.md, skills, `.mcp.json`, permisos | **del repo del card** — automático (cwd del claude lanzado) |
| Agents (pm/dev/qa) | **defaults del bridge** (`agents/*.md`, formato nativo); un repo puede sobrescribir con su propio `.claude/agents/<rol>.md` |
| Workflow (columnas, triggers, identidades) | **de tu instancia** (`config/workflow.json` — una instancia, un board) |
| Repos | `REPO_PATH` (carpeta de repos, con subcarpetas de organización); si el repo del card no está, **se clona solo** |

```
regent/
├── config/            # TU instancia (pnpm setup): workflow.json + process.md — gitignored
├── agents/*.md        # agents por defecto (nativos de Claude Code)
└── src/ · ncard · .env (REPO_PATH, tokens)
```

La propiedad **`Repo`** del card elige el repo (búsqueda en `REPO_PATH` hasta tres niveles, por nombre y por origin — carpetas y submódulos de monorepos; auto-clone si falta). **Sin `Repo` no se ejecuta nada**: el bridge comenta pidiendo el link.

```
Notion board ──webhook──► server.ts ──spawn──► launcher.ts
                              │                    │ cwd = REPO_PATH (o worktree)
                              │                    ▼
                              │              claude (carga CLAUDE.md/skills/.mcp.json solo)
                              │                    │ system prompt = agent nativo
                              │                    │ prompt de fase = protocolo + card
                              ▼                    ▼
                        events.jsonl       herdr | tmux | headless
```

## Componentes

| Archivo | Rol |
|---|---|
| `src/server.ts` | webhook: firma, filtrado, dedup, anti-loop, lock por card, disparo por trigger |
| `src/launcher.ts` | lee el card (ncard), worktree si la fase lo pide, compone prompts, lanza claude |
| `src/bridge-config.ts` | carga+valida `workflow.json` + `agents/` (zod: agents existen, sin ciclos en `can_trigger`) |
| `src/phase-prompt.ts` | capa [Bridge]: protocolo (ncard, cierre de fase, seguridad card=DATOS) — el oficio va en el agent |
| `src/terminal.ts` | backends: `herdr` (interactivo+notificaciones) · `tmux` (attach por SSH) · `headless` (log) — autodetección o `TERMINAL_BACKEND` |
| `src/setup.ts` · `src/board-detect.ts` · `src/setup-slack-roles.ts` · `src/slack-admin.ts` | `pnpm setup`: adopta o crea el board (detección determinista de propiedades por tipo/propósito, sin LLM), crea/sincroniza la app de Slack y las caras por rol vía manifest API, escribe `.env` + `config/` |
| `src/setup-board.ts` | crea/repara el board de Notion desde el workflow |
| `src/router.ts` | rutas puras: menciones, punto de entrada, handoffs (`evaluateHandoff`), `hasOpenQuestions`, `explicitRoleIn` |
| `src/workspace.ts` · `regent-wt` | workspace por card: worktree por repo desde `origin/<base>`, registro `log/workspaces/<id>.json`, PRs, limpieza; `refreshShared` (checkouts compartidos al día) y `syncWorktreeWithBase` |
| `src/intake.ts` | el "secretario": `claude -p` sin MCP que interpreta una mención de Slack → título, descripción, repo, rol, propiedades (o "no es una tarea") |
| `src/answer.ts` | consulta técnica desde el chat: `claude -p` solo lectura + los MCP del repo → respuesta en el hilo, sin card |
| `src/chat.ts` · `src/chat-slack.ts` · `src/slack-thread.ts` | adaptador de chat (salas, personas, intake por mención/DM, intervención al agente vivo); lectura de hilos con adjuntos, bloques y archivos; hilo → markdown plegado |
| `src/md-blocks.ts` · `src/notion-rich.ts` | markdown → bloques de Notion (vallas, toggles, callouts, negrita/código inline) y rich_text de Notion → mrkdwn de Slack |
| `src/claude-settings.ts` · `src/env.ts` | pre-siembra de trust/MCP/bypass de claude; `.env` de la instancia y de los agentes |
| `ncard` | CLI Notion: get (con comments+anchors), move, comment (stdin, markdown), append, subpage, seturl, setselect, setnum, setpeople, icon, whoami |

## `config/workflow.json` (config de la instancia)

**La frontera con `.env`:** `.env` guarda *secretos* y lo que cambia por *máquina* (tokens, IDs del board, `REPO_PATH`, `PORT`, `TERMINAL_BACKEND`). Todo lo que describe el **board** o el **comportamiento** vive en **`config/`** — la carpeta de TU instancia: git la ignora, `pnpm setup` la genera leyendo tu board, y tu equipo la edita sin que una actualización del producto la pise.

Ningún nombre de propiedad está hardcodeado: si tu board está en inglés o le faltan propiedades, se renombran acá (o se ponen en `null` y el pipeline deja de usarlas). `pnpm setup` las **detecta de tu board** y las escribe solas.

```jsonc
{
  "name": "Regent",               // como TU equipo llama a la app — firma del hub y menciones en la ayuda

  // propiedades del card (null = tu board no la tiene; el pipeline sigue sin ella)
  "status_property": "Status",
  "workspace_root": null,          // p. ej. "monorepo": el agente corre en su raíz (contexto completo) y abre un
                                   // worktree por repo que cambia con `regent-wt`; Repo pasa a ser opcional
  "agent_env_files": [],           // .env que viajan a cada agente (default: <raíz>/.env, como `set -a; source .env`)
  "agent_permissions": "allowlist", // o "bypass": sin confirmaciones — un agente desatendido no puede contestarlas
  "repo_property": "Repo",         // url del repo → elige el clon en REPO_PATH
  "default_base_branch": "develop", // rama base si el repo la tiene; null = default del repo
  "repo_base_branches": {},        // override explícito por repo: { "legacy-api": "master" }
  "pr_property": "PR",             // url del PR (la escribe el dev)
  "pr_merged_moves_to": "Done",    // columna al mergear TODOS los PRs del card (null = off)
  "estimation_property": "Estimación", // dónde va el tamaño; null = el board no lo tiene
  "estimation_values": ["S", "M", "L"], // valores EXACTOS del select (el agente no inventa)
  "agent_property": "Agente",      // qué agent corre — fuente de verdad del handoff
  "hop_property": "Hop",           // contador de saltos del handoff
  "model_property": "Modelo",      // override del modelo por card
  "progress_property": "Progreso",
  "owner_property": "Owner",       // dueño HUMANO (null = primera propiedad people del board)
  "participants_property": "Involucrados",
  "project_doc_property": "Proyecto Doc",

  "chat":   { "invite_users": [], "auto_invite_limit": 15 },  // [] = auto-descubre humanos del workspace
  "intake": { "model": "sonnet", "timeout_sec": 90,           // el "secretario" que lee las menciones
              "answer_timeout_sec": 300,                      // consulta técnica (lee código y datos)
              "landing_status": "Backlog" },                  // columna donde nace un card creado desde el chat
  "github": { "forward_repos": "auto" },                      // "auto" = repos de los cards activos; o lista fija

  // OPT-IN: solo corre si la propiedad vale run_value. Un card sin el valor NUNCA
  // se ejecuta — es lo correcto en un board compartido. (skip_value = opt-out histórico.)
  "agent_filter": { "property": "Ejecutor", "run_value": "Agente" },
  "max_hops": 3,
  "states": [
    { "name": "Backlog",     "group": "To-do" },
    { "name": "Planning",    "group": "In progress", "trigger": "pm",     "agent_moves_to": "Plan Review" },
    { "name": "Plan Review", "group": "In progress", "gate": "human" },
    { "name": "In Progress", "group": "In progress", "trigger": "dev", "agent_moves_to": "Testing", "use_worktree": true },
    { "name": "Testing",     "group": "In progress", "gate": "human" },
    { "name": "Done",        "group": "Complete", "terminal": true },
    { "name": "Canceled",    "group": "Complete", "terminal": true }
  ],
  "agents": {
    "pm":  { "allowed_tools": ["Read", "Glob", "Grep"], "chat": { "username": "PM 📋" }, "can_trigger": [] },
    "dev": { "allowed_tools": ["Read", "Glob", "Grep", "Edit", "Write", "Bash(git:*)", "Bash(gh:*)", "Bash(npm:*)"], "chat": { "username": "Dev 🧑‍💻" }, "can_trigger": [] }
  }
}
```

- `trigger` = nombre del agent en `.claude/agents/` que corre al ENTRAR a la columna.
- `agent_moves_to` / `agent_stays` = qué pasa al terminar. Con `"agent_stays": true` el card
  **no se mueve** (para boards sin compuerta después de la fase) y el agente avisa por
  comentario — que ahí pasa a ser obligatorio, porque es la única señal. Son excluyentes, y
  un `trigger` sin ninguno de los dos sigue siendo un error de config, no un "se queda".
- `agents.<n>.triggers.mentions` = textos que activan al agent desde un comentario (`@qa`); `triggers.page_created` = corre al crearse un card (rol triage). Requieren los eventos `comment.created` / `page.created` en la suscripción del webhook.
- `allowed_tools` = permisos de launch (sintaxis del CLI); el bridge agrega siempre `Bash(ncard)` y `Bash(regent-wt)`.
- `agent_permissions` = `allowlist` (default: fuera de `allowed_tools`, claude pide confirmación en la terminal y el agente se queda esperando) o `bypass` (`--permission-mode bypassPermissions`: sin confirmaciones; lo que el rol no deba hacer va en su prompt). Con herdr, un agente parado en un prompt se reporta en la sala del card (`agent_blocked`) en vez de quedar mudo.
- Modelo: `model_property` del card > frontmatter del agent > default del CLI.
- **Desde el chat**: una PREGUNTA ("¿por qué…?", "¿cómo funciona…?") se contesta en el hilo leyendo el código y, si el repo declara MCP (base de datos, telescope…), también datos — `claude -p` con Read/Grep/Glob + git + `mcp__<server>` de cada servidor del `.mcp.json`, el mismo `.env` que los agentes (`agent_env_files`), `intake.answer_timeout_sec` — sin card ni sala. Una TAREA crea el card y arranca por la **primera fase del pipeline** (la primera columna con `trigger`); solo un rol nombrado en el texto (`@qa`, `qa`) elige otro punto de entrada — el tono ("rápido", "urgente") no.
- `start_message` (frontmatter del agent) = lo que el rol dice en la sala al arrancar (`🔎 Investigando…`); sin él, `🤖 en marcha`. Los comentarios del agente se espejan a la sala con su formato (negrita, código) y son lo único que el equipo lee ahí: las preguntas abiertas van en el comentario, no en el cuerpo del card.
- **Precedencia general**: env del operador > `workflow.json` > defaults. Las claves que antes vivían en `.env` (`SLACK_INVITE_USERS`, `INTAKE_MODEL`, `INTAKE_TIMEOUT_SEC`, `GITHUB_FORWARD_REPOS`) siguen funcionando como override, y el server avisa al arrancar para que las muevas acá.

### Handoffs agente→agente (`can_trigger` + `max_hops`)

Un agent pasa trabajo a otro **mencionándolo en un comentario** (p. ej. QA encuentra un bug → comenta `@dev corrige X` → el dev itera el PR en el mismo worktree). Guardarraíles:

- El server solo procesa menciones de comentarios del bot si el **agent actual del card** (`agent_property`, la escribe el launcher) tiene al target en su `can_trigger`.
- `hop_property` cuenta la cadena: mención humana = hop 0; cada handoff incrementa; `max_hops` corta (default 3). El agente conoce su hop y sabe cuándo ya no puede delegar. Si el board no tiene esas dos propiedades (ambas en `null`), los handoffs quedan desactivados y todo pasa por humanos.
- `can_trigger` es un **DAG** (ciclos rechazados al validar): el retorno siempre pasa por un humano re-mencionando — compuerta humana por construcción.
- Comentario del bot sin mención = "respuesta final" del agent → libera el lock del card.

Los agents mención-activados **no mueven el card** (salvo que su rol lo indique): responden con comentario + icono ✅/⚠️. `owner_property` (people) es siempre un humano — el triage lo asigna al creador del card.

### Workspace: cards que tocan varios repos

Con `workspace_root` (nombre de carpeta bajo `REPO_PATH`) el agente **siempre corre en la raíz**:
ahí están `CLAUDE.md`, skills, `.mcp.json` y todos los repos legibles — checkouts compartidos,
**solo lectura**. Para cambiar un repo pide su worktree aislado con `regent-wt add <ruta>` (rama
`agent/<id>` desde la base resuelta) y trabaja ahí; puede abrir uno por cada repo que la tarea
necesite. Cada repo cambiado termina en **su propio PR** contra su base, registrado con
`regent-wt pr <repo> <url>`; el card avanza a `pr_merged_moves_to` cuando **todos** mergean, y
**Al día sin humano**: los checkouts compartidos se traen a su upstream con fast-forward cada hora y al arrancar cada agente (un submódulo detached pasa una vez a su rama base; lo sucio en archivos trackeados o divergido se deja y queda en el log `shared_refresh`); un worktree ya abierto recibe `origin/<base>` al arrancar el agente (merge; con conflicto se aborta y el prompt se lo marca al dev para que lo resuelva primero); un PR abierto que pasa a `CONFLICTING` se avisa una vez en la sala. Las ramas nuevas siempre nacen de `origin/<base>` recién traído, no del checkout local.
la limpieza (worktrees + ramas) es por registro (`log/workspaces/<id>.json`). Si al terminar un
agente hay cambios en un checkout compartido, el bridge lo avisa en la sala.

Sin `workspace_root` el card necesita `Repo` y el agente corre en el worktree de ese único repo
(el caso simple es el degenerado del mismo modelo).

## Setup

1. **Integración interna** en <https://app.notion.com/developers/connections> (Read/Update/Insert content + comments + user info sin emails) → secret a `.env` (`cp .env.example .env`).
2. **Config**: `pnpm setup` genera `config/` (workflow + process) leyendo tu board; ajusta `agents/*.md` si quieres; `.env`: `REPO_PATH` (carpeta con tus repos clonados). Los repos no necesitan setup — si ya usan Claude Code, su contexto aplica solo.
3. **Board**: crea una página, compártela con la conexión, y `node src/setup-board.ts --parent <page_id>` → IDs a `.env`. (Único paso manual cosmético: arrastrar opciones de Status a sus grupos en la UI.)
4. **Túnel** con URL estable (p. ej. [cftunnel](https://github.com/usedilver/cloudflare-tunnel-cli)): `cftunnel create notion-hooks <dominio> 8787`.
5. **Arrancar**: `pnpm start` + `cftunnel run notion-hooks`. En desarrollo: **`pnpm dev`** (watch nativo de Node — se reinicia solo al cambiar `src/`, `agents/`, `workflow.json` o `.env`). El launcher/prompts/agents nunca requieren reinicio: cada card lanza un proceso fresco.
6. **Webhook**: UI de la conexión → Create a subscription → `https://<host>/notion-webhook`, eventos `page.properties_updated` + `comment.created` (obligatorio para menciones y fases `agent_stays`; `page.created` solo con un rol `page_created`). El server captura el verification token; pégalo en Verify. ⚠️ URL inmutable tras verificar; una sola suscripción activa por board.

## Qué escribe un agente y dónde

Tres destinos, con reglas distintas, porque los lee gente distinta:

| Destino | Quién lo lee | Qué va |
|---|---|---|
| **Cuerpo del card** (`ncard append`) | negocio | `## Qué se va a hacer`, sin jerga. Nada de preguntas, estimación, PR ni estado (viven en propiedades) |
| **Subpágina "Plan técnico"** (`ncard subpage`) | el dev | archivos a tocar, pasos, riesgos; rutas y comandos en bloques de código; trazas largas en `<details>` |
| **Comentario de cierre** (`ncard comment <id> -`, markdown por stdin) | el equipo, **espejado tal cual en Slack** | línea `Magnitud: esfuerzo … · impacto … · N decisiones pendientes → vía rápida \| revisión humana`, y las **preguntas abiertas** — solo acá — cada una autocontenida y etiquetada `[rápida]` (sí/no) o `[con contexto]` (hay que mirar código o datos) |

El conversor markdown→Notion entiende vallas (también indentadas dentro de una viñeta), `<details><summary>` → toggle, `> [!QUESTION|WARNING|NOTE]` → callout, y negrita/cursiva/código/links inline → anotaciones. El hilo de Slack de origen se guarda plegado en un toggle con la traza como bloque de código.

**Un comentario con preguntas abiertas nunca es un handoff**: aunque mencione a otro rol, el server ignora la mención (`skip_handoff_open_questions`), lo avisa en la sala y libera el card. No existe "implementa cuando confirmen": primero llegan las respuestas, después un humano menciona al rol. El pm clasifica **esfuerzo** (código: va a `estimation_property`) e **impacto** (usuarios/registros afectados, visibilidad pública, datos de prod, reversibilidad) por separado; la vía rápida — pasarle el trabajo al dev sin revisión humana — exige esfuerzo mínimo, impacto bajo, cero preguntas y un plan inequívoco. La urgencia del pedido no es un criterio.

## Operación

- **Activación siempre explícita**: arrastrar el card a una columna con `trigger`, o mencionar un rol en un comentario (`@pm`, `@dev`, `@qa`). Crear o editar cards en columnas humanas no dispara nada. Con `agent_filter.run_value`, un card sin ese valor **nunca** se ejecuta (ni por mención: se contesta el motivo).
- **Fase con `agent_moves_to`**: el agente trabaja y mueve el card; el movimiento ES la notificación (el bridge publica `📍 Card → estado` en la sala, solo en movimientos reales, no en ecos). **Fase con `agent_stays`**: el card no se mueve; el comentario de cierre es la señal y libera el lock (por eso `comment.created` es obligatorio en la suscripción).
- **Desde Slack**: mención al bot en un hilo → el intake lee TODO el hilo (bots, adjuntos de apps, archivos, canales privados) con el contexto del workspace y crea el card en `intake.landing_status` con la sala `#task-<slug>`; el hilo de origen queda plegado en el card. Una **pregunta** no crea nada: se responde en el hilo leyendo código y datos. Una **tarea** arranca por la primera fase del pipeline; solo un rol nombrado elige otra. En la sala: texto plano = corrección al agente vivo (o intake sobre el card si no hay agente), `stop` lo interrumpe, `@rol` lo arranca.
- **Handoffs**: mención de un agente en su comentario → `can_trigger` + `max_hops` (`Agente`/`Hop` en el card son la verdad). Un handoff con preguntas abiertas se rechaza (ver arriba).
- **Git**: ramas `agent/<id>` desde `origin/<base>` recién traído (`default_base_branch` si existe en el remoto, si no el default del repo, salvo `repo_base_branches`). Cada hora y al arrancar un agente, los checkouts compartidos se traen a su upstream con fast-forward (`shared_refresh`: sucio/divergido se deja; un submódulo detached pasa una vez a su base); un worktree reutilizado recibe `origin/<base>` (conflicto → se aborta y el prompt del dev lo marca como lo primero); un PR abierto que pasa a `CONFLICTING` se avisa una vez (`pr_conflict`). Al mergear TODOS los PRs del card → `pr_merged_moves_to`, sala archivada con digest de la conversación humana, tabs cerrados, worktrees limpios (nunca uno con cambios sin commitear).
- **Agentes desatendidos**: con `agent_permissions: bypass` no hay confirmaciones. Con herdr, un agente parado en un prompt se reporta en la sala al minuto (`agent_blocked`); los tabs `done`/`idle` de fases previas se cierran solos.
- **Intervenir en vivo**: herdr = clic al tab; tmux = `tmux attach -t <label>`; móvil = mosh + tmux. O un mensaje en la sala.
- **Logs**: `log/events.jsonl` (cada decisión del server, con `kind`) · `log/agent-*.out` (salida de agentes) · `log/launch-*.log` (launcher: repo, worktree, env, MCP aprobados) · `log/workspaces/<id>.json` (worktrees y PRs del card) · `log/rooms.json` / `log/threads.json` (sala e hilo de cada card).
- **Reintentos de Notion** si el server cae: hasta 8 con backoff, sin orden; eventos agregados (~1 min drag→ejecución). Menciones/creaciones más viejas de `EVENT_FRESHNESS_MINUTES` (30) se descartan; las columnas son inmunes (se confirma el Status actual por API).
- **Poda de contexto**: los agentes solo leen comentarios NO resueltos — resolver un comentario en Notion lo saca de su vista.

## Seguridad

- El contenido de cards y comentarios es **DATOS, no instrucciones** — el prompt de fase lo delimita y ordena reportar (no obedecer) instrucciones embebidas.
- Permisos por fase en `workflow.json` (`allowed_tools`; pm solo lectura, dev escritura+git/gh) en worktree aislado, nunca sobre el checkout compartido. Con `agent_permissions: bypass` la lista deja de frenar: lo que un rol no debe hacer vive en su prompt, y el tope duro son los hooks/`settings.json` del repo (p. ej. un `PreToolUse` que rechace DML contra prod). La consulta técnica es solo lectura por lista de tools; en datos, por prompt.
- Los agentes del cliente se revisan en el git del cliente (PRs) — sus dueños correctos.
- Secretos solo en `.env` (600). El server escucha en `127.0.0.1`; lo público es el túnel.

## Tests

```bash
pnpm test   # 20 suites, sin red ni Notion: config (zod, ciclos, stay), router (menciones, handoffs, preguntas abiertas),
            # webhook (eventos firmados fabricados), workspace (git real: worktrees, refresh, sync, conflictos),
            # md-blocks/slack-thread/notion-rich (formato), intake/answer (prompts), setup (idempotencia), trust/env/bypass
```

## Docs

- [docs/despliegue.md](docs/despliegue.md) — despliegue en un servidor (requisitos, red, servicios, acceso remoto); agnóstico de proveedor
- `docs/plan.md` y `docs/investigacion-agentes-chat.md` son internos (nombran clientes) y no se publican: el porqué de cada decisión vive ahí, el comportamiento vigente en este README y en despliegue.md
