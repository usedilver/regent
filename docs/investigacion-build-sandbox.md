# Investigación: builds/workers que fallan dentro de regent (sandbox de Claude Code)

Bitácora abierta. Iniciada 2026-09-08. **Estado: fuga watch corregida y build real verificado.**
Documento de análisis, no contrato. Registra hallazgos, descartes y preguntas
abiertas para seguir. Actualizar en el mismo PR que avance el tema.

## Corrección y verificación ejecutadas (2026-09-08)

- `startRunner` elimina `WATCH_REPORT_DEPENDENCIES` de la copia del entorno antes
  del spawn. No modifica el entorno del servidor ni desactiva watch o sandbox.
- Regresión automatizada: el runner recibe la variable contaminante, lanza un
  proceso con un fork IPC y solo recibe el mensaje esperado del worker. También
  verifica que se conserve una variable legítima y no se mute el entorno de entrada.
- `pnpm build` del worktree real terminó con exit 0, cuatro workers y generación
  de páginas completa al eliminar la variable.
- Segunda prueba real mediante `startRunner`, inyectando la variable en sus
  opciones: `completed {"exit":0,"watch":null,"workerError":false,"pagesGenerated":true}`.
  Usó un adaptador determinista que ejecuta pnpm build, no una nueva sesión Claude;
  verifica la frontera de spawn sin gastar otro turno en instrucciones al modelo.
- `finishReply` tolera `message_not_in_streaming_state` y actualiza el mensaje
  existente. Otros errores de transporte se propagan a DurableOutput, conservando
  el stream conocido para reintentar en lugar de publicar otra respuesta con logs.
- Regresión Slack: stop aplicado con respuesta perdida, segundo stop devuelve
  stream cerrado, actualización final única y entrega marcada sent. No se publica
  un segundo mensaje ni el diagnóstico técnico en el hilo.
- `pnpm test` completo pasó. Pruebas sin despliegue ni escrituras de datos de app.
  El status Git del worktree conserva la misma lista de cambios pendientes.

Pendiente operativo: nueva prueba desde Slack con el servidor actualizado, limpieza
y commit del proyecto y despliegue. No se certifica el cierre real de Slack solo
con mocks. La recuperación de identidad de streams tras reinicio sigue siendo
parte de [la migración de progreso](v2-slack-progress.md), no de este arreglo.

Las listas de pendientes y conclusiones de secciones siguientes son históricas;
los puntos de filtrado y finalización se implementaron como se describe arriba.

## Revisión con logs y reproducción (2026-09-08)

**La hipótesis principal cambia: contaminación del entorno por `node --watch`,
no sandbox.** La sección histórica de abajo conserva hipótesis anteriores y sus
experimentos reportados; no debe leerse como diagnóstico vigente.

### Evidencia nueva

- Run SQLite `27046cbf-59ed-4b18-b719-5fdbe8497e7f`: estado `interrupted`, intent
  `ask`, duración 601187 ms. Registró 33 tool_use y 33 tool_result.
- El evento 2889 solicitó Bash con `dangerouslyDisableSandbox: true`; su resultado
  2890 reprodujo `Unexpected response from worker: undefined`.
- Settings actuales de usuario, padre Talently y app no definen `sandbox.enabled`.
  No prueba retrospectivamente todo el entorno, pero no hay base para recomendar
  desactivar aislamiento como arreglo de este incidente.
- Node 22.20.0, módulo interno `internal/main/watch_mode`, agrega siempre
  `WATCH_REPORT_DEPENDENCIES: '1'` al proceso supervisado, también con watch-path.
- Los loaders de Node consultan esa variable y, si existe `process.send`, emiten
  objetos IPC `watch:require` / `watch:import`.
- `jest-worker` incluido en Next 16.3.4 espera mensajes cuyo primer elemento sea
  un código numérico. Un objeto de reporte de imports tiene `message[0]` undefined,
  y produce exactamente la excepción observada.
- `core.ts` hereda process.env y `runner.ts` no filtra esa variable antes de lanzar
  Claude. No hace falta que Claude tenga IPC: la variable llega hasta los forks de
  Next, que sí tienen un canal IPC.

Reproducción mínima efectuada con el jest-worker instalado en la app, sin Claude,
sin DB, sin build y sin sandbox adicional:

```text
Worker con una función ping() -> "worker-ok"
Mismo Worker, WATCH_REPORT_DEPENDENCIES=1 -> exit 1
TypeError: Unexpected response from worker: undefined
```

Fixtures de diagnóstico local: `/private/tmp/regent-worker-probe.cjs` y
`/private/tmp/regent-worker-fixture.cjs`. No forman parte del producto.
También se inspeccionó el código embebido del propio Node con
`process.binding('natives')`, solo como diagnóstico, no como API de implementación.
La reproducción explica por qué las pruebas desde shell o claude -p fuera de
pnpm dev no fallaban. Falta repetir el build completo desde Regent con el fix;
no afirmar aún que el proyecto completo compila o está desplegado.

### Otros hallazgos del mismo turno

- Los comandos `pnpm build | ...; echo ${PIPESTATUS[0]}` terminaron con
  `BUILD_EXIT:` vacío. No son evidencia fiable del exit code en esta shell.
  Ejecutar build directamente o capturar su estado sin una tubería que lo oculte.
- Al final, las escrituras de limpieza fueron rechazadas por el margen de cierre,
  no por permisos de carpeta. Los logs contienen dos denegaciones por deadline.
- El worktree real sigue sucio y conserva `_dbcheck.mjs`; la limpieza y el commit
  no están terminados. No se modificaron esos archivos durante esta revisión.
- La `.worktreeinclude` del worktree real sí incluye `.env.local`; no atribuir el
  fallo de este run a su ausencia basándose en otro worktree de prueba.
- Slack muestra `message_not_in_streaming_state`: error independiente del build.
  `finishReply` intenta stopStream y, ante cualquier error, publica otra respuesta
  con el diagnóstico técnico. Debe reconciliar un stream ya cerrado y continuar
  con la actualización final, sin duplicar ni filtrar el error interno. No hay
  trazas HTTP suficientes para concluir quién cerró primero ese stream.

### Correcciones pendientes, en orden

1. Filtrar `WATCH_REPORT_DEPENDENCIES` en la frontera de spawn de `startRunner`,
   sobre la copia del entorno, sin alterar process.env ni desactivar watch en Regent.
2. Test de regresión de herencia y worker IPC; no filtrar indiscriminadamente
   variables legítimas del repo ni introducir excepciones globales de sandbox.
3. Repetir el build del worktree real vía Regent; después decidir si existe otro
   fallo de aplicación. No usar deploy cloud como sustituto del diagnóstico.
4. Hacer idempotente la finalización de Slack y cubrir stream ya cerrado y
   respuesta perdida tras stop; conservar una respuesta autoritativa.
5. Retomar limpieza, commit y despliegue del proyecto en un turno separado.
   El límite ask de 10 minutos es un problema adicional de flujo, no la causa IPC.

La política preview/cloud build puede seguir siendo útil, pero no corrige la
contaminación que también puede afectar tests y otros procesos con workers.

## Investigación anterior (hipótesis, no conclusiones vigentes)

## Síntoma

En el flujo de mini-proyecto (skill `talenter-project`: crear app Next + Neon +
deploy en Vercel), el paso local `pnpm build` falla **dentro de regent** con:

```
Collecting page data using N workers ...
Unexpected response from worker
```

El turno se consume diagnosticando y no termina el deploy. Caso real: app
`Talently-Oficial/dilver-renovaciones-prueba` (Next 16.3.4, Node 22.20.0).

## Hallazgo central: NO se reproduce en aislamiento

El **mismo** `pnpm build`, en la **misma máquina y Node**, corrió bien en 5 entornos.
Solo falló en aquel run puntual dentro de regent.

| Entorno de ejecución | Resultado |
| --- | --- |
| Shell normal | ✅ OK (4 workers) |
| Spawn `detached` + stdio en pipe (como regent) | ✅ OK |
| `sandbox-exec` denegando escrituras fuera del repo | ✅ OK |
| `sandbox-exec` denegando `network*` / `system-socket` | ✅ OK |
| `claude -p` normal (bypassPermissions, sin `--worktree`) | ✅ OK |
| `claude -p --worktree` (como regent) | ❌ exit 1, **pero NO** el error de workers (falla por otra causa, ver abajo) |
| Run real dentro de regent (worktree + app real) | ❌ "Unexpected response from worker" |

Conclusión provisional: **no es un bug determinista**. Fue transitorio (presión de
recursos / worker que murió) o específico del entorno completo de regent que aún no
replicamos exactamente. Descartado: máquina, versión de Node, spawn detached, stdio,
y un sandbox Seatbelt casero (escritura/red/sockets).

## Mecanismo candidato: sandbox de Bash de Claude Code

Claude Code (2.1.265) sandboxea Bash en macOS con **Seatbelt**. Los **procesos hijos
heredan** el aislamiento (filesystem + red), lo que **puede** romper el IPC de los
workers de build (jest-worker de Next) o sus llamadas de red al colectar page-data.
Es exactamente la clase de fallo del síntoma. Fuente:
[sandboxing](https://code.claude.com/docs/en/sandboxing),
[settings-reference](https://code.claude.com/docs/en/settings-reference),
[permission-modes](https://code.claude.com/docs/en/permission-modes).

Gotchas confirmados en la doc:

- **`--permission-mode bypassPermissions` NO desactiva el sandbox.** Son capas
  independientes: permisos deciden si pregunta; el sandbox decide qué alcanza el
  comando una vez corre. regent corre en bypass y **igual queda sandboxeado** si el
  sandbox está activo.
- No hay flag `--no-sandbox`. En headless se desactiva con
  `--settings '{"sandbox":{"enabled":false}}'`.
- El sandbox **no** está activo por defecto global: se activa con `/sandbox` (guarda
  en `.claude/settings.local.json`) o `sandbox.enabled: true` en settings de usuario.
  En este equipo `~/.claude/settings.json` tiene `sandbox` sin definir → **puede que
  ni esté activo**, lo que encaja con que `claude -p` normal buildeara bien. **Falta
  confirmar si algún `settings.local.json` lo activó.**

Knobs reales para arreglarlo (en `.claude/settings.json` del repo o de usuario):

```jsonc
// A) sacar comandos pesados del sandbox (recomendado)
{ "sandbox": { "excludedCommands": ["pnpm build", "next build", "pnpm test"] } }
// B) desactivar el sandbox del todo
{ "sandbox": { "enabled": false } }
// C) mantener aislamiento de red, quitar el de filesystem
{ "sandbox": { "filesystem": { "disabled": true } } }
```
`allowUnsandboxedCommands: true` (default) ya permite que un comando que falla en el
sandbox reintente fuera. regent lee project settings vía `--setting-sources`.

## Lo que NO es la causa (descartes)

- **`TALENTER_CONFIG_FILE` en el `.env.local` de la app** — NO rompe el build.
  La app lee `DATABASE_URL` (pegado directo en `.env.local`); ese puntero solo lo usa
  el script del skill (`project.mjs`), no `next build`. Es un **problema aparte** de
  higiene/seguridad: mete una ruta absoluta a un `.env` externo con secretos del
  operador (VERCEL_TOKEN, NEON_API_KEY, GITHUB_TOKEN, DB_PASSWORD…) en el env de la
  app; frágil (no existe en Vercel ni en worktree/sandbox) y con riesgo de fuga.
  Fix: que `project.mjs:103` deje de escribir `TALENTER_CONFIG_FILE` en el `.env.local`
  de la app; el `.env.local` de la app debe llevar solo lo que la app usa.
- **`claude -p --worktree` falla por otra razón** (exit 1, sin el error de workers):
  un worktree fresco no incluye archivos gitignored como `.env.local` salvo que estén
  en `.worktreeinclude`. Es completitud del entorno del worktree, no el crash de workers.

## Fixes candidatos (por capas)

1. **Deploy por Vercel cloud, sin gate de `pnpm build` local** (cubre el 99%).
   El build de Vercel es autoritativo y esquiva sandbox/worktree/transitorios.
   Cambiar en el skill `talenter-project`: `references/operations.md:91` (quitar el
   `pnpm build` como gate) y `assets/AGENTS.md:28` (verificar contra la URL desplegada:
   UI, acceso protegido, persistencia). `vercel --prod` (sin `--prebuilt`) ya buildea
   en la nube; `vercel.json` tiene `git.deploymentEnabled:false`, así que el deploy es
   por CLI.
2. **Builds/tests locales robustos dentro de regent** (opcional): `sandbox.excludedCommands`
   o `sandbox.enabled:false` en el `.claude/settings.json` del repo. Baja aislamiento;
   decisión del operador.
3. **Práctica general**: local = checks livianos sin workers (tsc, lint, `next dev`);
   nube = build de producción + verificación de la URL desplegada.

## Preguntas abiertas / siguiente análisis

- [ ] **Reproducir el crash de forma determinista.** ¿Es la app real (conexión a Neon
      al colectar page-data) + sandbox de red, y no una página trivial? Probar el
      build del código real del worktree, no del bootstrap.
- [ ] **Confirmar si el sandbox está activo** en este equipo (`/sandbox`,
      `settings.local.json`). Si no lo está, la causa NO es el sandbox y hay que buscar
      otra (transitorio de recursos, el propio `--worktree` de Claude Code).
- [ ] **Probar el fix del sandbox**: correr el build vía `claude -p --worktree
      --settings '{"sandbox":{"excludedCommands":["pnpm build"]}}'` y ver si pasa.
- [ ] **¿regent debería pasar `--settings` con `excludedCommands`** para comandos de
      build/test, o dejarlo al `.claude/settings.json` del repo?
- [ ] **`.worktreeinclude`**: asegurar que el `.env.local`/`.env` que la app necesita
      llegue al worktree; documentar en el skill.
- [ ] **Intent para mini-proyectos**: Slack usa `ask` (10 min). Un crear+deploy no cabe.
      ¿Detectar intent `task` (1h) o subir el tope? (fase 4, despriorizada.)
- [ ] **Aplicar el fix del skill en el template canónico** (`talenter-template`), no
      solo en la copia sembrada de cada app.

## Referencias

- Claude Code sandbox: https://code.claude.com/docs/en/sandboxing
- Settings: https://code.claude.com/docs/en/settings-reference (claves `sandbox.*`)
- Permission modes vs sandbox: https://code.claude.com/docs/en/permission-modes
- Caso: `Talently-Oficial/dilver-renovaciones-prueba`; skill `talenter-project`.
