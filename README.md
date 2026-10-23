# Regent

Agente de código conversacional para Slack, Claude Desktop y terminal, basado en
el CLI oficial de Claude Code. Puede investigar y modificar proyectos usando sus
propias instrucciones, skills y conexiones. Cada conversación trabaja en un
worktree separado y conserva su contexto al continuar.

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
e instala el [plugin cliente](client-plugin/README.md). Puedes ejecutar solo MCP
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
REGENT_DB=log/cli.sqlite pnpm regent ask "Explica este proyecto"
```

## Referencia

| Necesito…                                            | Consultar                                 |
| ---------------------------------------------------- | ----------------------------------------- |
| Configurar proyectos, acceso, respuestas o ejecución | [Configuración](config/README.md)         |
| Instalar o distribuir el plugin para Claude Desktop  | [Plugin cliente](client-plugin/README.md) |
| Desarrollar y contribuir a Regent                    | [Contribuciones](CONTRIBUTING.md)         |

Para desarrollar: `pnpm dev`. Para ejecutar las comprobaciones: `pnpm test`.
