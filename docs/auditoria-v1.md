# Auditoria de retiro de v1

## Limpieza local completada

Se eliminaron tmp/, worktrees/ (incluidos los worktrees de prueba v2), el almacen
local vacio .pnpm-store/, plugin/skills vacio, metadatos .DS_Store y 33 entradas
antiguas de log/. Se retiraron cuatro registros Git de worktrees, incluidos dos
anidados. No se eliminaron ramas remotas ni worktrees nativos de otros proyectos.

Los unicos elementos ignorados restantes son .env, config/regent.yaml,
node_modules/ y log/v2.sqlite. PRAGMA quick_check devolvio ok y la base conserva
24 conversaciones. El nombre v2.sqlite se mantiene por compatibilidad.

Se retiraron tambien docs/plan.md, docs/investigacion-agentes-chat.md y la copia
docs/archive/despliegue-v1.md. La documentacion v1 versionada sigue disponible en
Git, no en el checkout. Las decisiones historicas de v2 no son runtime de v1 y se
conservan en docs/v2-history.md. La lista inferior describe la auditoria previa;
su referencia a conservar la guia v1 queda sustituida por esta limpieza.

2026-09-08. Alcance: producto y estructura, no datos de instancia.

## Retirado

- .claude/skills/crear-agente: generaba roles, columnas y DAG del pipeline v1.
- config/workflow.json y config/process.md: configuracion local ignorada, sin
  consumidor en el runtime actual. Eliminada a peticion del operador; no contenia
  la configuracion actual regent.yaml. Respaldar otras instancias v1 antes del cambio.
- plugin/skills: vacio; los skills pertenecen a cada repositorio.
- ncard, notion-sections y md-blocks: cliente/renderer de Notion de v1.
- workspace.ts: registro de worktrees por card, reemplazado por aislamiento nativo.
- router.ts, effects.ts y migrate.ts: sin consumidores del runtime. Se retira
  tambien el test del importador v1 y pruebas exclusivas de utilidades retiradas.
- Dependencia directa @notionhq/client: no debe ser necesaria para usar Regent.

## Conservado

- plugin/colleague.md y plugin/hooks: protocolo y controles activos del CLI.
- env.ts, claude-settings.ts y slack-thread.ts: utilizados por el runtime actual.
- Migraciones de SQLite: mantienen instalaciones existentes. No borrar tablas
  historicas ni task_id mediante una limpieza de archivos.
- log/v2.sqlite, nombres de worktree y sesiones: identidades persistentes sin cambios.
- .env, config/regent.yaml, credenciales, logs y repos de usuario: no modificados.
- Docs historicos identificados como tales; despliegue.md ahora describe Regent actual.

## Estructura

src/v2 pasa a src; imports relativos y entrypoints actualizados. Tests dejan de
usar prefijo v2, manifest pasa a slack-manifest.json. Se retiran aliases start:v2
y test:v2; usar pnpm start y pnpm test. La version del producto puede seguir siendo
v2 sin duplicar arboles de codigo. Actualizar servicios que invoquen src/v2/server.ts.

## Validacion

Suite automatizada completa, instalacion con lockfile congelado y busqueda de
imports/entrypoints retirados. No equivale a deploy Docker ni a prueba real Slack.
Tras actualizar, detener el watcher anterior y volver a ejecutar pnpm dev o el
servicio de produccion con src/server.ts. No borrar la DB para resolver rutas.
