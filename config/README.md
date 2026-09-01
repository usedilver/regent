# config/ — tu instancia

Todo lo que hay en esta carpeta es **tuyo**: describe TU board y TU proceso, no el
producto. Git la ignora (salvo este README) — edítala con libertad, nada se pisa
al actualizar regent.

La genera **`pnpm setup`** leyendo tu board real. Contiene:

| Archivo | Qué es |
|---|---|
| `workflow.json` | Tu board y tu comportamiento: columnas y qué agente dispara cada una, nombres de TUS propiedades, handoffs (`can_trigger`), salas de chat, intake, repos de GitHub. También `name`: cómo se llama tu app — así firma en el chat. |
| `process.md` | La narrativa de tu proceso, **inyectada al prompt de todos los agentes**. Reglas del equipo, convenciones de PRs, cuándo escalar a humanos. Se genera una vez desde el workflow y de ahí en adelante es de tu equipo: si cambias columnas, actualízalo. |

Los agents por defecto (`../agents/*.md`) sí son del producto; para personalizar
un rol en un repo concreto, crea `.claude/agents/<rol>.md` en ese repo.

La regla general: **`.env` = secretos y máquina · `config/` = board y comportamiento · el resto = producto.**
