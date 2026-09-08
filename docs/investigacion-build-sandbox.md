# Investigación: builds/workers que fallan dentro de regent (sandbox de Claude Code)

Bitácora abierta. Iniciada 2026-09-08. **Estado: SIN RESOLVER — hay que cerrarlo.**
Documento de análisis, no contrato. Registra hallazgos, descartes y preguntas
abiertas para seguir. Actualizar en el mismo PR que avance el tema.

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
