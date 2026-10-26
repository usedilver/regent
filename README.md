# Regent

Agente de código conversacional para Slack, Claude Desktop y terminal, basado en
el CLI oficial de Claude Code. Puede investigar y modificar proyectos usando sus
propias instrucciones, skills y conexiones. Las consultas leen el repositorio existente;
los cambios usan un worktree separado por conversación y conservan el contexto al continuar.

## Empezar

Necesitas Node.js ≥22.20, pnpm y Claude Code ≥2.1.263 instalado y autenticado.
Para una instalación nueva con Slack:

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm regent setup --repo /ruta/a/repos/proyecto --team T012345 --user U012345
```

Instala una app de Slack con [el manifiesto](slack-manifest.json) y completa
`SLACK_BOT_TOKEN` y `SLACK_APP_TOKEN` en `.env`. Luego ejecuta:

```sh
pnpm start
```

El modo `indie` usa tu login personal de Claude Code. Para un equipo, configura
`auth.mode: team` y `ANTHROPIC_API_KEY`. Los secretos van en `.env`; los ajustes,
en `config/regent.yaml`. Consulta [configuración y acceso](config/README.md).
Slack usa Socket Mode y no necesita una URL pública.

Para Claude Desktop, configura [OAuth y HTTPS](config/README.md#oauth-login-for-mcp)
e instala el [plugin cliente genérico](plugins/regent/README.md). Puedes ejecutar solo MCP
con `pnpm start:mcp`, sin conectar Slack, o ambos con `pnpm start`.

## Uso

En Slack, menciona al bot en un canal o escríbele por DM. Por ejemplo:

> Revisa el último commit de ai-interview sin modificar archivos.
>
> Agrega un gráfico de registros mensuales al dashboard y comprueba que funciona.

Responde dentro del mismo hilo para continuar; `stop` detiene ese trabajo.
Las respuestas son breves por defecto. Pide detalles técnicos cuando los necesites.
El proyecto puede indicarse por nombre, URL o ruta; si se omite, se parte del
repositorio predeterminado de la instancia.

También puedes consultar desde terminal. Si el servidor está activo, usa otra
base de sesiones para la CLI:

```sh
REGENT_USER_ID=U012345 REGENT_DB=log/cli.sqlite pnpm regent ask "Explica este proyecto"
```

## Referencia

| Necesito…                                            | Consultar                                  |
| ---------------------------------------------------- | ------------------------------------------ |
| Configurar proyectos, acceso, respuestas o ejecución | [Configuración](config/README.md)          |
| Instalar o distribuir el plugin para Claude Desktop  | [Plugin cliente](plugins/regent/README.md) |
| Desarrollar y contribuir a Regent                    | [Contribuciones](CONTRIBUTING.md)          |

Para contribuir: `pnpm install --frozen-lockfile` y `pnpm check`, sin credenciales de producción.
Consulta [arquitectura](ARCHITECTURE.md) para ubicar cada módulo.

## Desarrollo

`pnpm dev` ejecuta la instancia local completa, Slack y MCP, y la reinicia al cambiar `src/`,
`plugins/executor/` o `.env`. Para desarrollar dentro de la misma imagen que despliega producción
(Node 22, Claude CLI, git, gh y Python), con el repositorio montado y el mismo reinicio automático:

```sh
docker compose up --build                # Slack + MCP, igual que pnpm dev
docker compose run --rm dev pnpm check   # las comprobaciones de CI en la imagen
```

El contenedor lee `.env`, monta `~/Projects` (o `REGENT_PROJECTS`) en `/home/node/Projects` y usa
su propia base `log/dev.sqlite`. Publica `127.0.0.1:8788` (o `REGENT_PORT`). Claude usa
`ANTHROPIC_API_KEY` si está en `.env`; si no, inicia sesión una vez con
`docker compose exec dev claude`, que persiste en el volumen del home. Detén antes cualquier otra
instancia con el mismo app token de Slack: dos procesos conectados se reparten sus eventos.
