# Despliegue de Regent

Guia del runtime conversacional actual. La guia de v1 queda en
[el archivo historico](archive/despliegue-v1.md); sus comandos no aplican aqui.

## Requisitos

- Node 22.20.0 o una version compatible con TypeScript nativo y node:sqlite.
- pnpm segun packageManager; Git y Claude Code oficial con las capacidades
  comprobadas por src/server.ts al arrancar (incluido worktree nativo).
- Acceso saliente a Slack y proveedores configurados por los repositorios.
- Directorios persistentes y escribibles por el usuario del servicio.

No se requiere webhook de Notion, tunel publico, tmux ni herdr. El servidor HTTP
interno escucha en 127.0.0.1:8788; no exponer el endpoint de herramientas a internet.

## Preparacion

1. Instalar con `pnpm install --frozen-lockfile` y ejecutar `pnpm test`.
2. Configurar `.env` a partir de `.env.example`, sin versionar valores secretos.
3. Ejecutar `pnpm regent setup --repo /ruta/repos/contexto --team T_ID --user U_ID`.
   Para equipo, usar `--mode team` y configurar ANTHROPIC_API_KEY. Para individual,
   autenticar el CLI con el usuario del servicio; no compartir la suscripcion.
4. Instalar la app Slack con `slack-manifest.json` y verificar usuarios autorizados.
5. Preparar repos, sus herramientas, MCPs y credenciales bajo el usuario del servicio.
6. Iniciar con `pnpm start`. `pnpm dev` solo es para desarrollo, no produccion.

## Persistencia y supervision

Configurar systemd o launchd con directorio de trabajo absoluto, PATH explicito,
usuario dedicado, reinicio ante fallo y cierre SIGTERM con tiempo suficiente.
No ejecutar como root. Conservar el HOME del CLI y sus sesiones, config/regent.yaml,
repositorios y sus .claude/worktrees, ademas de la base SQLite.

La base por defecto sigue siendo `log/v2.sqlite` por compatibilidad. No renombrarla
como parte de una actualizacion de codigo. REGENT_DB permite otra ruta explicita.
Para backups usar backup consistente de SQLite o detener el servicio; no copiar
solo el archivo principal mientras existen escrituras/WAL activos.

Dockerfile inicia src/server.ts como usuario node. Montar config, log, repos y
credenciales con permisos adecuados; no copiar secretos a la imagen. Las rutas
del host deben ajustarse a los montajes. El contenedor no importa sesiones por si
solo. La imagen y su flujo de autenticacion requieren prueba en el host destino.

## Reemplazo de v1

- [ ] Respaldar estado/configuracion de v1 fuera de este checkout antes del cambio.
- [ ] Detener sus servicios y suscripciones que ya no deban procesar eventos.
- [ ] Evitar dos procesos con el mismo app token: Slack puede repartir eventos.
- [ ] Arrancar Regent y verificar salud, una consulta y un cambio con PR.
- [ ] Probar parada, continuacion, pregunta, traslado e historial incremental.
- [ ] Cortar/restaurar red y reiniciar; comprobar entregas y contexto.
- [ ] Conservar checkout y procedimiento de rollback independientes de la instancia nueva.

Las sesiones de terminal y el pipeline de v1 no se convierten en sesiones Claude
conversacionales. No hay importador de workflow.json en el runtime actual.
La configuracion y el estado de instalaciones v2 existentes se conservan.
