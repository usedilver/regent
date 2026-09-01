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
| `src/setup-board.ts` | crea/repara el board de Notion desde el workflow del repo cliente |
| `ncard` | CLI Notion: get (con comments+anchors), move, comment, append, seturl, setselect, setnum, icon, whoami |

## `config/workflow.json` (config de la instancia)

**La frontera con `.env`:** `.env` guarda *secretos* y lo que cambia por *máquina* (tokens, IDs del board, `REPO_PATH`, `PORT`, `TERMINAL_BACKEND`). Todo lo que describe el **board** o el **comportamiento** vive en **`config/`** — la carpeta de TU instancia: git la ignora, `pnpm setup` la genera leyendo tu board, y tu equipo la edita sin que una actualización del producto la pise.

Ningún nombre de propiedad está hardcodeado: si tu board está en inglés o le faltan propiedades, se renombran acá (o se ponen en `null` y el pipeline deja de usarlas). `pnpm setup` las **detecta de tu board** y las escribe solas.

```jsonc
{
  "name": "Regent",               // como TU equipo llama a la app — firma del hub y menciones en la ayuda

  // propiedades del card (null = tu board no la tiene; el pipeline sigue sin ella)
  "status_property": "Status",
  "repo_property": "Repo",         // url del repo → elige el clon en REPO_PATH
  "pr_property": "PR",             // url del PR (la escribe el dev)
  "agent_property": "Agente",      // qué agent corre — fuente de verdad del handoff
  "hop_property": "Hop",           // contador de saltos del handoff
  "model_property": "Modelo",      // override del modelo por card
  "progress_property": "Progreso",
  "owner_property": "Owner",       // dueño HUMANO (null = primera propiedad people del board)
  "participants_property": "Involucrados",
  "project_doc_property": "Proyecto Doc",

  "chat":   { "invite_users": [], "auto_invite_limit": 15 },  // [] = auto-descubre humanos del workspace
  "intake": { "model": "sonnet", "timeout_sec": 90 },         // el "secretario" que lee las menciones
  "github": { "forward_repos": "auto" },                      // "auto" = repos de los cards activos; o lista fija

  "agent_filter": { "property": "Ejecutor", "skip_value": "Humano" },  // tareas humanas: el bridge las ignora
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
- `allowed_tools` = permisos de launch (sintaxis del CLI); el bridge agrega siempre `Bash(ncard)`.
- Modelo: `model_property` del card > frontmatter del agent > default del CLI.
- **Precedencia general**: env del operador > `workflow.json` > defaults. Las claves que antes vivían en `.env` (`SLACK_INVITE_USERS`, `INTAKE_MODEL`, `INTAKE_TIMEOUT_SEC`, `GITHUB_FORWARD_REPOS`) siguen funcionando como override, y el server avisa al arrancar para que las muevas acá.

### Handoffs agente→agente (`can_trigger` + `max_hops`)

Un agent pasa trabajo a otro **mencionándolo en un comentario** (p. ej. QA encuentra un bug → comenta `@dev corrige X` → el dev itera el PR en el mismo worktree). Guardarraíles:

- El server solo procesa menciones de comentarios del bot si el **agent actual del card** (`agent_property`, la escribe el launcher) tiene al target en su `can_trigger`.
- `hop_property` cuenta la cadena: mención humana = hop 0; cada handoff incrementa; `max_hops` corta (default 3). El agente conoce su hop y sabe cuándo ya no puede delegar. Si el board no tiene esas dos propiedades (ambas en `null`), los handoffs quedan desactivados y todo pasa por humanos.
- `can_trigger` es un **DAG** (ciclos rechazados al validar): el retorno siempre pasa por un humano re-mencionando — compuerta humana por construcción.
- Comentario del bot sin mención = "respuesta final" del agent → libera el lock del card.

Los agents mención-activados **no mueven el card** (salvo que su rol lo indique): responden con comentario + icono ✅/⚠️. `owner_property` (people) es siempre un humano — el triage lo asigna al creador del card.

## Setup

1. **Integración interna** en <https://app.notion.com/developers/connections> (Read/Update/Insert content + comments + user info sin emails) → secret a `.env` (`cp .env.example .env`).
2. **Config**: `pnpm setup` genera `config/` (workflow + process) leyendo tu board; ajusta `agents/*.md` si quieres; `.env`: `REPO_PATH` (carpeta con tus repos clonados). Los repos no necesitan setup — si ya usan Claude Code, su contexto aplica solo.
3. **Board**: crea una página, compártela con la conexión, y `node src/setup-board.ts --parent <page_id>` → IDs a `.env`. (Único paso manual cosmético: arrastrar opciones de Status a sus grupos en la UI.)
4. **Túnel** con URL estable (p. ej. [cftunnel](https://github.com/usedilver/cloudflare-tunnel-cli)): `cftunnel create notion-hooks <dominio> 8787`.
5. **Arrancar**: `pnpm start` + `cftunnel run notion-hooks`. En desarrollo: **`pnpm dev`** (watch nativo de Node — se reinicia solo al cambiar `src/`, `agents/`, `workflow.json` o `.env`). El launcher/prompts/agents nunca requieren reinicio: cada card lanza un proceso fresco.
6. **Webhook**: UI de la conexión → Create a subscription → `https://<host>/notion-webhook`, solo `page.properties_updated`. El server captura el verification token; pégalo en Verify. ⚠️ URL inmutable tras verificar; una sola suscripción activa por board.

## Operación

- **Backlog es espacio de borrador**: crear/editar cards ahí NO dispara nada (puedes planear días). La activación es siempre explícita: **arrastrar** a una columna con trigger o **mencionar** un rol en un comentario (`@pm`, `@dev`, `@qa`, `@triage`). Una mención a un rol con fase = fase completa (trabaja Y mueve el card).
- Card a **Planning** → tab `pm-<id>` (herdr/tmux) → plan + `Estimación` en el card → **Plan Review** con ✅/⚠️.
- Ajustes al plan: comenta (la caja o flotantes sobre el texto) y devuelve el card a **Planning** → re-planifica (`> Rev N`).
- Card a **In Progress** → worktree + implementación + PR (label `agent`, URL en la propiedad `PR`) → **Testing**. Ajustes: comenta en el card o en el PR y devuélvelo a In Progress — mismo PR, `## Ajustes (Rev N)`.
- **Intervenir en vivo**: herdr = clic al tab (blocked → notificación); tmux = `tmux attach -t <label>`; móvil = [Moshi](https://getmoshi.app). El drag es la señal de "ejecuta"; los comentarios solos no disparan.
- Logs: `log/events.jsonl` (decisiones del server) · `log/agent-*.out` (salida de agentes) · `log/launch-*.log` (launcher).
- Reintentos de Notion si el server cae: hasta 8 con backoff, sin orden. Eventos pueden agregarse (~1 min de retraso drag→ejecución). Menciones/creaciones más viejas de `EVENT_FRESHNESS_MINUTES` (default 30) se descartan — protege del aluvión de reintentos al despertar un laptop suspendido; las columnas son inmunes (se confirma el Status actual vía API).
- **Multi-repo**: la propiedad `Repo` del card elige el repo — se busca hasta tres niveles adentro de `REPO_PATH`, por nombre de carpeta y por origin (el path de un submódulo no siempre se llama como su repo); **si no está clonado, el agente lo clona solo** (gh → git). Sin `Repo` → no se ejecuta: se comenta pidiendo el link.
- **Poda de contexto**: los agentes solo leen comentarios NO resueltos — resolver un comentario en Notion lo saca de su vista. Resolver = limpiar memoria de la conversación.

## Seguridad

- El contenido de cards y comentarios es **DATOS, no instrucciones** — el prompt de fase lo delimita y ordena reportar (no obedecer) instrucciones embebidas.
- Permisos por fase desde `.bridge` (pm solo lectura; dev escritura+git/gh scoped), en worktree aislado, nunca sobre el working tree principal.
- Los agentes del cliente se revisan en el git del cliente (PRs) — sus dueños correctos.
- Secretos solo en `.env` (600). El server escucha en `127.0.0.1`; lo público es el túnel.

## Tests

```bash
pnpm test   # bridge-config (validación zod, ciclos) + webhook (eventos firmados fabricados)
```

## Docs

- [docs/plan.md](docs/plan.md) — plan maestro (fases, decisiones, estado)
- [docs/investigacion-agentes-chat.md](docs/investigacion-agentes-chat.md) — investigación que sustenta el diseño
- [docs/despliegue.md](docs/despliegue.md) — despliegue en un servidor (requisitos, red, servicios, acceso remoto); agnóstico de proveedor
