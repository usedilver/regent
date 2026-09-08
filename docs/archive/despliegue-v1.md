# Despliegue en un servidor

regent corre en cualquier máquina Linux con Node 22+ y acceso saliente a internet. Este doc está escrito por **requisitos**, no por proveedor: EC2, Lightsail, GCP, Hetzner, un Mac mini bajo tu escritorio o un contenedor cumplen lo mismo. Donde el proveedor importa se dice explícitamente.

> El despliegue ES el test de portabilidad del proyecto. Si algo de acá no cuadra con la realidad al montarlo, corrige este doc en el mismo PR.

---

## 1. Qué estás desplegando

Un proceso Node de larga vida que escucha eventos y lanza `claude` con el repo del card como directorio de trabajo. No es un servicio web: la única razón de tener URL pública es que **Notion solo entrega por webhook HTTP**.

```
Notion ──webhook (necesita URL pública)──┐
Slack  ──Socket Mode (saliente)──────────┼──► server (node, 127.0.0.1:PORT)
GitHub ──gh webhook forward (saliente)───┘         │
                                                   │ spawn
                                                   ▼
                                    claude (cwd = repo o worktree del card)
                                                   │
                                        herdr │ tmux │ headless
```

De las tres integraciones, **solo Notion necesita entrada desde internet**. Slack va por WebSocket saliente y GitHub puede ir por `gh webhook forward`, también saliente. Eso define casi todo lo demás.

---

## 2. Requisitos

### 2.1 Máquina

| Recurso | Mínimo | Por qué |
|---|---|---|
| RAM | 4 GB | cada card lanza un `claude`; los builds de frontend son lo que más pesa |
| Disco | 20 GB+ | clones de repos + un worktree por card en vuelo |
| CPU | 2 vCPU | el bridge es I/O-bound; la CPU la usan los builds y tests de los agentes |
| SO | Linux con systemd (Ubuntu 22.04/24.04 probado) | las unidades de usuario de §5 asumen systemd |
| Red | salida a internet | Notion API, Slack, GitHub, API de Anthropic |

Si vas a correr varios agentes en paralelo, sube RAM antes que CPU.

### 2.2 Software

```bash
node --version     # >= 22  (el proyecto usa type-stripping nativo: no hay paso de build)
pnpm --version     # gestor del proyecto (npm i -g pnpm)
git --version
gh auth status     # autenticado: los agentes crean PRs y el poller lee su estado
claude --version   # npm i -g @anthropic-ai/claude-code
```

Opcionales, cada uno habilita una capacidad concreta:

| Binario | Qué habilita | Sin él |
|---|---|---|
| `tmux` | agentes interactivos + intervenir por SSH | cae a headless |
| `herdr` | tabs gestionados, estados y notificaciones | cae a tmux |
| extensión `gh-webhook` | merges de PR al instante (`gh extension install cli/gh-webhook`) | el poller detecta el merge en ≤`PR_POLL_MINUTES` |

**El backend de terminal decide si puedes intervenir a media tarea.** `TERMINAL_BACKEND` fuerza uno; vacío autodetecta en este orden: herdr → tmux → headless. En un servidor, **tmux** es lo simple (agentes interactivos a los que te enganchas por SSH); **herdr** en modo server headless da además estados por tab (`working`/`blocked`/`done`) que regent usa para avisar agentes trabados y cerrar tabs terminados — ver §5. Headless funciona igual pero el agente queda encerrado en su log, sin forma de corregirlo en vivo.

`claude` conviene instalarlo con su instalador nativo (`curl -fsSL https://claude.ai/install.sh | bash` → `~/.local/bin/claude`), no con `npm -g` como root: el CLI se auto-actualiza y necesita escribir en su carpeta. Lo que herdr/tmux lanzan **no hereda el entorno del servicio**: regent inyecta a cada agente los `.env` de `agent_env_files` (default: el `.env` de la raíz del workspace), que es de donde resuelven los `${VARS}` del `.mcp.json` del repo.

### 2.3 Credenciales

Esto es lo que hay que resolver **antes** de aprovisionar nada, porque no es un problema técnico.

**Claude.** El bridge lanza el CLI de `claude`, así que la máquina necesita una sesión autenticada:

- `claude setup-token` genera un token OAuth de larga duración (se exporta como `CLAUDE_CODE_OAUTH_TOKEN`). Requiere abrir una URL en un navegador, así que se genera en tu portátil y se lleva al servidor.
- `ANTHROPIC_API_KEY` si prefieres consumo por API en vez de suscripción.

Decide **de quién es la cuenta antes de desplegar**. Si pones la tuya en la infraestructura de un cliente, su pipeline muere el día que expire, la rotes o cambies de plan. Si es la del cliente, necesita su propia suscripción autenticada ahí. No es un detalle de configuración: es quién paga y quién queda bloqueado cuando falle.

**GitHub.** `gh auth login` + `gh auth setup-git` sobre HTTPS es lo más simple. Una deploy key con escritura por repo es más acotada si el servidor no es tuyo.

**Notion.** Integración interna en <https://app.notion.com/developers/connections> con Read/Update/Insert content, comments y user info. El board debe compartirse con la conexión.

**Slack** (opcional): una app con Socket Mode. `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`.

---

## 3. Red

La única pregunta real es **cómo llega el webhook de Notion**. Tres formas, de menos a más expuesta:

| Opción | Puertos de entrada | Notas |
|---|---|---|
| **Túnel saliente** (cloudflared, tailscale funnel, ngrok) | ninguno | el servidor conecta hacia afuera; el grupo de seguridad queda cerrado |
| **Reverse proxy con TLS** (Caddy, nginx) | 443 | necesitas dominio y certificado; Caddy lo resuelve solo |
| Exponer el puerto directo | — | no lo hagas: el server habla HTTP plano |

El server escucha en `HOST` (default `127.0.0.1`), así que **lo público es siempre el túnel o el proxy, nunca el proceso**. Si usas contenedor, ponlo en `0.0.0.0` y deja que la red del contenedor haga de frontera.

Para administrar (SSH, attach a tmux) usa una VPN de la tailnet o el gestor de sesiones de tu proveedor en vez de abrir el 22.

**Endpoints:**

| Ruta | Método | Para qué |
|---|---|---|
| `/healthz` | GET | verificación; responde `{"status":"ok"}` |
| `$WEBHOOK_PATH` (default `/notion-webhook`) | POST | eventos de Notion, firma HMAC verificada |
| `/github-webhook` | POST | eventos de PR; el estado se re-verifica con `gh` siempre |

---

## 4. Instalación

```bash
git clone <repo-del-bridge> ~/regent
cd ~/regent
pnpm install
pnpm setup
```

`pnpm setup` es el camino: detecta el entorno, pregunta lo mínimo y **escribe** `.env` y `config/` (workflow.json + process.md — la carpeta de tu instancia, ignorada por git). Es re-ejecutable como doctor. Si ya tienes un board de Notion, lo lee y deriva el workflow de **tus** columnas, detectando los nombres de tus propiedades — no necesitas que el board esté en español ni que se llame como el default.

Si no tienes board, el wizard escribe un workflow default y te dice cómo crearlo:

```bash
node src/setup-board.ts --parent <page_id>   # imprime DATABASE_ID y DATA_SOURCE_ID
```

Verifica antes de seguir:

```bash
pnpm run validate    # config del bridge: agents, estados, ciclos en can_trigger
pnpm test            # 26 tests
```

### La frontera de configuración

Confundirla es la fuente de problemas más común al desplegar:

- **`.env`** — secretos y lo que cambia por **máquina**: `NOTION_TOKEN`, `SLACK_*`, `DATABASE_ID`, `DATA_SOURCE_ID`, `REPO_PATH`, `PORT`, `HOST`, `TERMINAL_BACKEND`. Va con permisos `600` y nunca al repo.
- **`config/`** — TU instancia (la genera `pnpm setup`, git la ignora): `workflow.json` (board y comportamiento: columnas, triggers, nombres de propiedades, handoffs, chat, intake, GitHub) y `process.md` (reglas del equipo inyectadas a los agentes).

`REPO_PATH` es la carpeta de clones. La propiedad `Repo` del card elige el repo dentro de ella (busca directo y un nivel adentro, validando el origin); si no está clonado, **el bridge lo clona solo**. Un card sin `Repo` no ejecuta nada: el bridge comenta pidiendo el link.

---

## 5. Ejecución

Corre bajo tu usuario, no como root. Con systemd, usa unidades de usuario con `linger` para que sobrevivan al logout:

```bash
sudo loginctl enable-linger $USER
mkdir -p ~/.config/systemd/user
```

`~/.config/systemd/user/regent.service`:

```ini
[Unit]
Description=regent (Notion/Slack → agentes)
After=network-online.target

[Service]
WorkingDirectory=%h/regent
ExecStart=/usr/bin/node %h/regent/src/server.ts
EnvironmentFile=%h/regent/.env
Environment=TERMINAL_BACKEND=tmux
Environment=CLAUDE_CODE_OAUTH_TOKEN=…
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now regent
curl -s http://127.0.0.1:8787/healthz     # {"status":"ok"}
```

`Environment=CLAUDE_CODE_OAUTH_TOKEN=…` es una de las dos opciones: la otra es un `claude` logueado interactivamente en la caja (§2.3) y entonces esa línea sobra. `PATH` debe incluir `%h/.local/bin` (claude, herdr) y lo que usen los repos (Go, etc.): el server y sus hijos no cargan tu shell.

**Con herdr** (`TERMINAL_BACKEND=herdr`): dos unidades más, y regent arranca después de ellas (`After=herdr-workspace.service`). herdr necesita un workspace activo para crear tabs; el oneshot lo garantiza en cada boot.

```ini
# ~/.config/systemd/user/herdr.service
[Unit]
Description=herdr server (headless) — tabs y agentes de regent
After=default.target
[Service]
ExecStart=%h/.local/bin/herdr server
Environment=TERM=xterm-256color
Restart=on-failure
[Install]
WantedBy=default.target

# ~/.config/systemd/user/herdr-workspace.service
[Unit]
Description=Garantiza un workspace activo en herdr
After=herdr.service
Requires=herdr.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=%h/.local/bin/herdr-ensure-workspace   # espera al socket; `herdr workspace create --cwd ~/Projects --label regent` si no hay ninguno
[Install]
WantedBy=default.target
```

Para un servidor **sin humano mirando**, `"agent_permissions": "bypass"` en `workflow.json`: sin él, la primera herramienta fuera de `allowed_tools` (un MCP, un comando) deja al agente esperando un "¿proceder?" que nadie contesta. regent pre-acepta el aviso de bypass y los MCP del `.mcp.json` del repo (`~/.claude/settings.json`, `~/.claude.json`), así que el agente arranca sin diálogos.

Un arranque sano imprime los triggers, si el token de verificación está puesto, el adaptador de chat, el modo de PRs y si el board concuerda con el workflow.

**Contenedor.** El `Dockerfile` incluido corre en **modo headless** (sin herdr ni tmux: agentes sin intervención en vivo). `.env`, `workflow.json` y las credenciales de `claude`/`gh` se montan como volúmenes. Úsalo si priorizas reproducibilidad sobre poder corregir a un agente a media tarea.

---

## 6. Conectar Notion

Con el server y el túnel arriba:

1. Conexión → **Webhooks** → Create a subscription.
2. URL: `https://<tu-host><WEBHOOK_PATH>`. Eventos: `page.properties_updated` y `comment.created`
   (`page.created` solo si algún agent tiene `triggers.page_created`). Marcar eventos de más
   (`page.content_updated`…) no rompe nada: el server los descarta (`skip_type`), solo hacen ruido en el log.

   ⚠️ `comment.created` es **obligatorio** si usás menciones **o** alguna fase con
   `agent_stays`: en esas fases el card no se mueve, así que el comentario del agente es
   la única señal de que terminó. Sin ese evento el card queda bloqueado hasta el TTL.
3. Notion envía un POST sin firmar con el `verification_token`; el server lo captura y lo registra en `log/`. Pégalo en **Verify**.

⚠️ **Dos cosas que muerden en una migración:**

- La URL queda **inmutable** tras verificar. Para cambiarla hay que borrar la suscripción y crear otra.
- **Una sola suscripción activa por board.** Si migras desde otra máquina y dejas las dos vivas, cada card lanza agentes duplicados. Borra o pausa la vieja *antes* de verificar la nueva.

---

## 7. Conectar Slack (opcional)

Habilita las salas por card, crear tareas mencionando al bot y corregir agentes desde el chat.

1. `pnpm setup` **crea la app por vos**: pedile un *App Configuration Token*
   (api.slack.com/apps → "Your App Configuration Tokens" → Generate, **expira a las 12 h**) y
   la crea desde `slack-manifest.json` con el nombre de tu instancia vía `apps.manifest.create`.
   Slack no deja automatizar solo dos pasos, y el wizard te da el link directo a cada uno:
   **instalar** la app (Allow) y **generar el token app-level** con `connections:write`, que
   únicamente existe en Basic Information. Valida los dos tokens antes de guardarlos.
   Socket Mode no necesita URL pública.

   Al **re-correr** `pnpm setup`, el manifest del repo se sincroniza con la app
   (`apps.manifest.update`): si agregaste un scope o un evento, se aplica solo. Cambiar
   `oauth_config.scopes` es lo único que obliga a **reinstalar** —el wizard lo detecta y te
   da el link—; lo demás toma efecto al instante.
2. A quién invitar a cada sala se configura en `workflow.json` → `chat.invite_users`; vacío auto-descubre los humanos del workspace hasta `chat.auto_invite_limit`.
   El manifest pide `groups:history`/`groups:read` (hilos en canales privados), `files:read` (archivos adjuntos) y `mpim:history`: sin ellos el intake trabaja a ciegas y lo dice en el hilo (`thread_unreadable`). Una app creada con un manifest anterior necesita **reinstalarse** para tomarlos. El setup no crea apps duplicadas al re-correr (`SLACK_APP_ID` en `.env`).
3. Opcional — **caras reales por rol** (`@Planner`, `@Dev`, `@QA` como menciones de verdad): `node src/setup-slack-roles.ts`. Crea una app de identidad por rol vía la API de manifests. Necesita un `SLACK_CONFIG_TOKEN` (api.slack.com/apps → Your App Configuration Tokens, **expira a las 12 h**) y un clic de instalación por app, que Slack no permite automatizar. Deja los tokens como `SLACK_BOT_TOKEN_<ROL>`.

---

## 8. Merges de PR

Cuando el PR de un card se mergea, el card va a `pr_merged_moves_to`, la sala se archiva, los tabs se cierran y el worktree y la rama se limpian (conservador: **no borra un worktree con cambios sin commitear**).

Dos vías, y conviene tener ambas:

- **Por evento** — `github.forward_repos` en `workflow.json`. Con `"auto"` escucha los repos de los cards activos y se re-evalúa en cada ciclo, así un repo nuevo entra sin reiniciar. Requiere la extensión `gh-webhook`; es saliente, sin URL pública. También puedes apuntar un webhook de repo a `/github-webhook` con `GITHUB_WEBHOOK_SECRET`.
- **Por poll** — respaldo automático cada `PR_POLL_MINUTES` (default 2) usando `gh`. Sin credenciales nuevas.

El estado del PR **siempre** se re-verifica con `gh` antes de actuar: el webhook es la señal, la API es la verdad.

---

## 9. Operación

```bash
systemctl --user status regent
journalctl --user -fu regent

tail -f log/events.jsonl        # decisiones del server (por qué disparó o no)
ls -t log/agent-*.out | head    # salida de cada agente
tmux ls                         # agentes vivos; tmux attach -t <label> para intervenir
```

**Contexto al día.** Cada hora, y al arrancar cada agente, regent trae los checkouts de `REPO_PATH` a su upstream con fast-forward (`shared_refresh` en el log: `updated` / `up-to-date` / `switched` para un submódulo detached que pasa a su base / `skipped:dirty|diverged|no-upstream`). No hace falta entrar a hacer `git pull`; sí conviene mirar el log si algo queda `skipped`: es un checkout que alguien dejó con trabajo a medias.

**Qué requiere reiniciar y qué no.** El código del server sí. `workflow.json`, `agents/*.md` y `process.md` no: cada card lanza un proceso fresco que los relee. En desarrollo, `pnpm dev` reinicia solo al cambiar `src/`, `agents/`, `workflow.json` o `.env`.

**Rollback.** `systemctl --user disable --now regent` y pausa la suscripción en Notion. El board queda como un kanban manual y el equipo sigue trabajando: ninguna tarea depende de que el bridge esté vivo.

**Entrega de eventos.** Notion agrega eventos en ventanas: puede pasar ~1 minuto entre el drag y la ejecución. Si el server estuvo caído, reintenta hasta 8 veces con backoff y sin orden garantizado; `EVENT_FRESHNESS_MINUTES` (default 30) descarta los reintentos viejos para que al volver no se dispare un aluvión de agentes.

---

## 9.1 Intervenir a un agente en marcha

Los agentes viven en el servidor; tus dispositivos son clientes que miran e intervienen sobre la misma sesión. Es la capacidad que distingue este sistema de un cron con IA, así que vale la pena dejarla probada.

**Con tmux** (lo habitual en un servidor):

```bash
ssh <host>
tmux ls                     # sesiones vivas: una por card en marcha
tmux attach -t <label>      # entrar; Ctrl-b d para salir sin matarla
```

**Con herdr**, te atachas al server remoto en vez de sincronizar dos instancias:

```bash
herdr --remote <user>@<host> --session bridge
```

`--session <name>` elige la sesión persistente, `--remote-keybindings <local|server>` decide de quién son los atajos (default `local`) y `--handoff` hace handoff en vivo al reatachar. En `~/.config/herdr/config.toml`, `manage_ssh_config = true` (default) genera un config SSH que incluye el tuyo primero y añade `ServerAliveInterval`/`ServerAliveCountMax` como fallback para sobrevivir timeouts de NAT.

⚠️ `experimental.allow_nested = false` por defecto: **no lances `herdr --remote` desde dentro de un pane de herdr**. Usa una ventana de terminal aparte.

**Desde el móvil**, necesitas un cliente SSH que aguante una TUI. Blink Shell (de pago) es el mejor porque soporta **mosh**, que sobrevive al bloqueo de pantalla y al cambio de WiFi a datos; Termius es la alternativa gratuita. mosh necesita UDP 60000-61000 alcanzables, lo cual se resuelve solo si entras por la VPN de tu tailnet.

```bash
mosh <user>@<host> -- tmux attach -t <label>
```

Para solo vigilar, los comandos de una línea rinden mucho más que la TUI en pantalla pequeña:

```bash
tmux ls
tail -5 ~/regent/log/events.jsonl
```

Un agente bloqueado (pidió un permiso o hizo una pregunta) se reporta en la sala del card al minuto (herdr lo marca `blocked`) y se desbloquea escribiéndole en su sesión. Para un servidor desatendido conviene `"agent_permissions": "bypass"` en `workflow.json`: sin confirmaciones no hay dónde quedarse parado. Desde Slack también: un mensaje en la sala del card se inyecta al agente vivo, y `stop` lo interrumpe.

---

## 10. Seguridad

- El contenido de cards y comentarios es **datos, no instrucciones**: el prompt de fase lo delimita y ordena reportar —no obedecer— cualquier instrucción embebida.
- Herramientas acotadas por fase en `workflow.json`: el pm es solo lectura; el dev añade escritura y git/gh, y trabaja en un **worktree aislado**, nunca sobre el working tree principal.
- Secretos solo en `.env` con `600`. El server escucha en loopback; lo público es el túnel o el proxy.
- El modelo de confianza es **equipo interno**: cualquiera con acceso al board o al Slack puede crear tareas y apuntar a cualquier repo, y el bridge lo clonará y correrá sus builds. Es deliberado. Si algún día el board se comparte fuera del equipo responsable, eso deja de ser cierto y hay que revisarlo.

---

## 11. Checklist

**Antes de aprovisionar**

- [ ] Decidido de quién es la cuenta de Claude y cómo se autentica en el servidor
- [ ] Decidido cómo entra el webhook de Notion (túnel o proxy con TLS)

**Máquina**

- [ ] ≥4 GB RAM, ≥20 GB disco, salida a internet
- [ ] node ≥22, pnpm, git, `gh auth status` ✓, `claude` autenticado
- [ ] `tmux` instalado (o herdr server + workspace oneshot; o asumido el modo headless a conciencia)
- [ ] `agent_permissions` decidido (`bypass` si nadie va a estar mirando la terminal)

**Bridge**

- [ ] `pnpm install && pnpm setup` completado
- [ ] `pnpm run validate` y `pnpm test` en verde
- [ ] Servicio arrancando solo y `/healthz` respondiendo en loopback

**Integraciones**

- [ ] `/healthz` responde por la URL pública
- [ ] Suscripción de Notion verificada con `page.properties_updated` + `comment.created`, **y la vieja borrada o pausada**
- [ ] Slack conectado (si aplica), app instalada con los scopes del manifest actual, y una sala creada
- [ ] Una mención en un hilo con adjunto de app (Sentry/Laravel Log) crea el card con el hilo plegado y la traza como código
- [ ] Merges por evento o poll confirmados sobre un PR real

**Prueba end-to-end**

- [ ] Card a la columna del pm → plan escrito → avanza a revisión
- [ ] Card a la columna del dev → worktree → PR abierto
- [ ] Intervención a media tarea probada (attach a tmux o mensaje desde Slack)
- [ ] PR mergeado → card a Done, sala archivada, worktree limpio
