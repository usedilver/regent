---
name: crear-agente
description: Crea un nuevo agente de rol para el pipeline regent en el repo cliente (REPO_PATH) - genera el agent nativo de Claude Code + su entrada en .bridge/workflow.json, valida el conjunto, e imprime los pasos manuales restantes. Usar cuando el usuario pida crear/agregar un agente o rol nuevo al pipeline.
---

# Crear un agente de rol para regent

El "cerebro" vive en el repo del cliente: un agente = `.claude/agents/<name>.md` (nativo de Claude Code) + entrada en `.bridge/workflow.json` (cuándo despierta, permisos de launch, identidad).

## Proceso

1. **Averigua del usuario** (pregunta solo lo que no esté ya en la conversación):
   - Rol y encargo (¿qué hace? ¿cuál es su salida principal?)
   - Nombre corto (`[a-z-]+`), username para chat (p. ej. "PM 🧭") y emoji
   - Activación: ¿columna del board (cuál, y a qué columna mueve al terminar)? ¿mención (@pm)? ¿al crear cards (page_created)?
   - Herramientas: ¿solo lectura? ¿escritura? ¿git/gh? → traduce a reglas (`Read`, `Glob`, `Grep`, `Edit`, `Write`, `Bash(git:*)`, …). Mínimo necesario.
   - Handoffs: ¿a qué agentes puede pasar trabajo (`can_trigger`)? Recuerda: sin ciclos.
   - Modelo: ¿default del CLI o fijo (haiku/sonnet/opus)?

2. **Lee ejemplos existentes** en `agents/` del bridge para copiar el estilo. Estructura del agent:
   - Frontmatter: `name`, `description` (cuándo corre + qué produce), `tools` (nombres nativos), `model` opcional.
   - Cuerpo = system prompt del rol: identidad, método numerado, reglas duras al final (qué NO puede hacer, cuándo NO mover el card, evidencia requerida). El protocolo del pipeline (ncard, cierre, seguridad) NO va aquí — lo inyecta el bridge.

3. **Escribe** `agents/<name>.md` (del bridge; o `.claude/agents/<name>.md` de un repo si es override por-repo) y agrega la entrada en `workflow.json` del bridge → `agents.<name>`: `allowed_tools`, `chat {username, emoji}`, `can_trigger`, `triggers {mentions, page_created}`. Si es trigger de columna: agrega `trigger`/`agent_moves_to` (y `use_worktree` si escribe código) al estado correspondiente en `states`.

4. **Valida**: `pnpm run validate` (en el dir del bridge). Corrige hasta que pase — detecta agents inexistentes, ciclos en can_trigger, targets de movimiento inválidos.

5. **Imprime los pasos manuales restantes**:
   - Si usa mención o page_created y la suscripción del webhook no incluye `comment.created` / `page.created`: agregarlos en la UI de Notion (conexión → Webhooks → Edit subscription).
   - Commitear los archivos nuevos (bridge o repo según dónde viva el agent).
   - Los prompts de agents aplican al siguiente lanzamiento; **cambiar `workflow.json` requiere reiniciar el server** (lo carga al arrancar).

## Reglas

- Nunca inventes permisos amplios: `Bash` sin scope solo si el rol lo justifica y el usuario lo confirma.
- `can_trigger` es un DAG: si el usuario pide A→B y B→A, explica que el retorno lo hace un humano re-mencionando (compuerta humana) y deja solo una dirección.
- El agente nunca es Owner del card: Owner es siempre humano.
