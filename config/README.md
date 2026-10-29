# Configuración de la instancia

[Volver al README](../README.md). Esta página es una referencia para quien administra
Regent. El código y [regent.example.yaml](regent.example.yaml) definen los campos
admitidos y sus valores predeterminados.

## Archivos

| Archivo                    | Uso                                      | En Git |
| -------------------------- | ---------------------------------------- | ------ |
| `regent.yaml`              | Configuración activa                     | No     |
| `regent.example.yaml`      | Plantilla de configuración               | Sí     |
| `access.yaml`              | Listas de acceso recargables             | No     |
| `access.example.yaml`      | Plantilla de listas de acceso            | Sí     |
| `communication.md`         | Reglas personalizadas de comunicación    | No     |
| `communication.example.md` | Enlace a la política incluida; plantilla | Sí     |

Crea la instancia con `pnpm regent setup --repo /ruta/al/proyecto --team T_ID --user U_ID`.
El setup no sobrescribe archivos ni valida conexiones; `--workspace` amplía la
carpeta de proyectos y `--user` puede repetirse. El setup conserva el formato de listas en línea compatible con instancias existentes.
También puedes copiar ambas plantillas para separar los accesos desde el inicio.
Slack y MCP leen `config/regent.yaml`; `REGENT_CONFIG` permite elegir otro archivo.
`regent.example.yaml` no se carga como configuración activa.

Los secretos del servidor van en `.env`, el estado en `log/` y los auxiliares locales
o respaldos en `tmp/local/`. Conserva la base SQLite al actualizar la instancia.

La imagen Docker incluye Python 3, `venv` y `pip` para scripts del agente. En una
instalación directa sobre Debian/Ubuntu, instala `python3 python3-venv python3-pip`.
Las dependencias de cada script o proyecto se instalan en su propio entorno virtual
(`python3 -m venv .venv` y `.venv/bin/python -m pip install ...`), sin modificar el
Python del sistema. Disponer de Python no amplía los permisos del modo consulta.

## Recarga de accesos

La configuración de arranque y los permisos editables tienen ciclos distintos. Para
activar la recarga en una instancia existente:

1. Copia `access.example.yaml` a `access.yaml` y reemplaza los IDs de ejemplo por
   los valores actuales de `slack.allowed_users`. Si usas OAuth, incluye también
   sus correos autorizados actuales bajo `oauth.allowed_emails`.
2. Añade a `regent.yaml`:

   ```yaml
   access_policy_file: config/access.yaml
   ```

3. Retira las listas duplicadas de `slack.allowed_users` y
   `mcp.oauth.oidc.allowed_emails` en `regent.yaml`. Reinicia una vez para activar
   el archivo. Después, edita únicamente `access.yaml`:

   ```yaml
   slack:
     allowed_users: [U012345, U067890]
   oauth:
     allowed_emails:
       - authorized.person@example.com
   ```

La ruta se resuelve desde la instalación de Regent, incluso con `REGENT_CONFIG`;
acepta rutas absolutas y `~/`. El archivo externo es la fuente de acceso autoritativa.
Con `access_policy_file: null` u omitido, se mantienen las listas en línea y requieren
reinicio. La CLI lee la política una vez por invocación.

Después de editar el archivo, recarga los accesos explícitamente:

```sh
systemctl --user reload regent
journalctl --user -u regent -n 20 --no-pager
```

No hay temporizador, watcher ni cron para las listas. El mismo proceso recibe `SIGHUP`,
lee el archivo y valida todo el documento antes de sustituir ambas listas en memoria.
Editar o reemplazar el archivo no aplica permisos hasta enviar esa señal. Los logs
confirman `applied`, `valid; effective permissions unchanged` o `rejected`; un error
conserva la última política válida y no imprime valores. Al arrancar, un archivo
seleccionado ilegible o inválido impide iniciar. Se aceptan guardados atómicos y
archivos de hasta 128 KiB; no se admiten campos adicionales ni YAML malformado.

Para habilitar el comando en una unidad de usuario existente:

```sh
mkdir -p ~/.config/systemd/user/regent.service.d
cp examples/regent-reload.conf ~/.config/systemd/user/regent.service.d/reload.conf
systemctl --user daemon-reload
```

[El drop-in](../examples/regent-reload.conf) añade `ExecReload=/bin/kill -HUP $MAINPID`.
`ExecStart` debe ejecutar Node directamente (ruta absoluta a `node` y `src/server.ts`
o `src/mcp-server.ts`), para que `MAINPID` sea Regent, no un wrapper de pnpm o shell.
Instala esta configuración después de desplegar la versión con soporte de `SIGHUP`.
`daemon-reload` actualiza la definición de systemd; no reinicia Regent ni recarga los
accesos. En una unidad de sistema, usa el directorio de drop-ins de `/etc/systemd/system/`
y los comandos con `sudo systemctl`/`sudo journalctl`, sin `--user`.

Sin systemd, envía `kill -HUP <PID_DE_NODE_REGENT>` al PID exacto del servidor, también
en desarrollo; no al supervisor de `node --watch` ni al grupo de procesos. En Docker
con Node como PID principal puedes usar `docker kill --signal=HUP <contenedor>`.
La señal y `systemctl reload` confirman su envío, **no** que el archivo haya sido
aceptado: comprueba el resultado en los logs. No uses `restart` para recargar listas.

`slack.allowed_users` debe estar presente. Una lista `[]` permite miembros activos
verificados del workspace, excluyendo bots; **amplía el acceso**. `oauth.allowed_emails`
es obligatorio si OAuth está configurado y exige al menos un correo válido. Las listas
son independientes: un ID de Slack no concede acceso OAuth, ni al revés.

Retirar una persona rechaza nuevos pedidos, respuestas a preguntas, consentimientos,
intercambios de códigos, renovaciones y peticiones con tokens OAuth existentes. Los
trabajos en ejecución y sus entregas pueden terminar. Sus trabajos en cola quedan
interrumpidos con la razón, sin bloquear los de otros autores en una sala. Esto incluye
continuaciones automáticas por cambio de repositorio. Restaurar el acceso no ejecuta
los trabajos interrumpidos; la persona debe enviar un nuevo pedido. Una sesión OAuth
no revocada ni vencida puede volver a funcionar al restaurar su acceso.

Cambiar la ruta, el workspace, el motor, modelos, límites, puertos, proveedor OAuth,
callbacks, `.env`, `mcp.enabled` o los tokens técnicos `mcp.principals` requiere reinicio.
`pnpm dev` observa el código, el protocolo y `.env`; las listas solo se recargan
con `SIGHUP`, igual que en producción. Otros cambios de configuración requieren reinicio manual.

## Active Settings

| Ajuste                                           | Comportamiento                                                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                           | Nombre visible del MCP; no cambia el perfil de la app de Slack ni los identificadores `regent_*`.                                                 |
| `auth.mode`                                      | `indie` usa el login local de Claude Code; `team` requiere `ANTHROPIC_API_KEY`. Autentica el motor, no a quienes llaman al MCP.                   |
| `slack.workspace_team_id` / `access_policy_file` | Workspace de arranque y archivo de listas recargables; consulta la sección de accesos.                                                            |
| `repos.path` / `workspace_root` / `default_repo` | Proyectos accesibles y contexto inicial. El predeterminado es relativo al workspace; no sustituye un destino explícito.                           |
| `repos.agent_env_files`                          | Archivos de entorno para el agente. Vacío carga el `.env` de la raíz del proyecto seleccionado.                                                   |
| `repos.readonly_mcp`                             | Restricciones adicionales del hook; usa también credenciales de solo lectura en la fuente.                                                        |
| `permission_mode`                                | `bypass` omite los permisos nativos; `native` respeta `allow/ask/deny` y puede denegar solicitudes en modo headless. Los hooks no son un sandbox. |
| `slack.progress_mode`                            | `auto` para actividades; `plain` para texto actualizado.                                                                                          |
| `communication.instructions_file`                | Archivo de comunicación personalizado; se explica abajo.                                                                                          |
| `models` / `limits`                              | Modelo, concurrencia, duración, inactividad y cancelación por perfil.                                                                             |
| `budget`                                         | Límites por ejecución y usuario en modo `team`; no limitan una suscripción personal.                                                              |
| `session.idle_reset_hours`                       | Reinicio de sesiones inactivas elegibles; no elimina su historial.                                                                                |
| `mcp`                                            | Habilitación del endpoint externo y acceso mediante OAuth o tokens técnicos.                                                                      |

Usa `indie` para el operador individual y `team` para uso compartido. El modo individual
advierte ante acceso abierto o varios usuarios, pero no bloquea el arranque. La
configuración no sustituye las condiciones del proveedor; consulta [contribuciones](../CONTRIBUTING.md).

## Communication Policy

`plugins/executor/colleague.md` define el protocolo de ejecución; cada repositorio aporta sus
convenciones. Para personalizar las respuestas de Slack, MCP y CLI:

```sh
cp config/communication.example.md config/communication.md
```

Selecciona el archivo en `regent.yaml`:

```yaml
communication:
  instructions_file: config/communication.md
```

Las rutas son relativas a la instalación de Regent, independientemente del proyecto
elegido o de `REGENT_CONFIG`; también se aceptan rutas absolutas y `~/`. Null u
omisión usa `plugins/executor/communication.md`; `communication.example.md` enlaza a ese recurso como plantilla. Un archivo explícito debe ser legible,
contener texto y no superar 32 KiB; los errores detienen la ejecución.

Editar el contenido aplica al siguiente pedido, incluso al continuar una conversación,
sin reiniciar el servidor. Cambiar la ruta configurada sí requiere reiniciarlo.
Cada ejecución recibe una copia temporal privada del protocolo y la política, que
se elimina al terminar. Claude Code administra la caché; los cambios pueden invalidarla.

Estas reglas controlan presentación, no permisos. Conserva los riesgos, fallos y
limitaciones relevantes y no incluyas secretos. El cliente MCP puede reformular el
resultado; la política del servidor no controla otras respuestas del cliente.

## OAuth Login for MCP

OAuth identifica a las personas que conectan al MCP, separado del login del motor.
Configura un proveedor OpenID Connect con correo verificado:

```yaml
mcp:
  enabled: true
  principals: []
  oauth:
    issuer_url: https://code.example.com
    trust_proxy: loopback
    redirect_uris:
      - https://claude.ai/api/mcp/auth_callback
    oidc:
      issuer_url: https://accounts.google.com
      client_id: YOUR_APPLICATION_ID
      client_secret_env: REGENT_MCP_OIDC_CLIENT_SECRET
```

1. Registra `https://code.example.com/oauth/callback` en el proveedor y guarda su
   secreto en la variable indicada, dentro de `.env`.
2. Configura los callbacks del cliente y los correos autorizados en `access.yaml`, sin comodines.
   La lista se verifica al iniciar sesión, renovar tokens y acceder al MCP; concede
   acceso al workspace de esta instancia, sin roles por proyecto.
3. Publica por HTTPS el mismo origen del issuer y verifica login, reconexión y
   desconexión desde el cliente antes de distribuir el plugin.

Google es un ejemplo. El proveedor debe soportar OIDC; la sesión JWT de Hire no es
intercambiable sin una integración. `trust_proxy: loopback` admite un proxy local;
usa `none` sin él. El issuer es explícito, no se deduce de cabeceras HTTP.

Publica únicamente `/mcp`, `/.well-known/oauth-protected-resource/mcp`,
`/.well-known/oauth-authorization-server`, `/authorize`, `/register`, `/token`,
`/revoke`, `/oauth/callback` y `/oauth/consent`. Mantén `/tools`, `/tool-policy`,
`/hook-denial`, `/healthz` y `/metrics` internos. Localhost sirve para pruebas;
los conectores remotos de Claude necesitan HTTPS accesible públicamente.

El consentimiento requiere CSRF y origen válido: conserva `Referrer-Policy:
same-origin` y la CSP que permite redirigir solo a los orígenes configurados.
El protocolo usa PKCE y tokens propios ligados al recurso; descarta los tokens
upstream y no entrega secretos de transporte al agente.

Los access tokens duran 15 minutos; los refresh tokens rotan dentro de una sesión
de siete días. Reutilizar un refresh token revoca la sesión. SQLite conserva hashes,
identidades verificadas y sesiones entre reinicios; los logins en curso deben
reiniciarse. Cada identidad solo puede consultar o continuar sus propios trabajos.
Los callbacks requieren reinicio; los usuarios del archivo externo se actualizan con
recarga manual. Revocar acceso no cancela un trabajo que ya está ejecutándose.

Como alternativa, `mcp.principals` vincula un ID a una variable `REGENT_MCP_TOKEN_*`.
Usa tokens distintos de al menos 32 caracteres; reinicia para rotarlos. Los trabajos
creados con un token no se reasignan al migrar esa persona a OAuth.

## Proyectos y ejecución

El modo explícito `ask` lee el repositorio existente sin crear worktree. Los mensajes
normales (`task`) y las opciones `patch`/`project` crean o reutilizan el worktree aislado;
el modelo interpreta el alcance del pedido con las instrucciones del proyecto. Una pregunta
no autoriza escrituras aunque haya herramientas disponibles. Las consultas explícitas
posteriores leen ese mismo trabajo; Regent no interpreta aprobaciones ni continuaciones.

El hilo y su historial son independientes del directorio. Al pasar del checkout al
worktree, una sesión CLI nueva recibe un resumen acotado de lo investigado; las sesiones
MCP del cliente y la conversación Regent continúan. La base conserva `session_cwd`
(esquema 12), sin borrar sesiones ni worktrees anteriores. Haz respaldo antes de actualizar;
una versión antigua no puede abrir una base con esquema nuevo.

Se conserva el `permission_mode` configurado (`native` o `bypass`); las restricciones
de consulta se aplican en ambos modos. En consulta están disponibles lectores de archivos,
skills, descubrimiento y consultas MCP; el agente usa `regent_git_read` para historial/diffs/estado. Se bloquean Bash,
intérpretes, herramientas de escritura y subagentes. Los MCPs siguen cargándose
desde el proyecto; sus operaciones deben cumplir las convenciones de consulta y sus
credenciales deben limitar los datos en la fuente. Estas restricciones no son un sandbox
para código de configuración o servidores MCP confiables. La selección de herramientas
nativas usa las [opciones del CLI oficial](https://code.claude.com/docs/en/cli-reference).

Los submódulos Git pertenecen a su proyecto raíz y conservan las conexiones y skills
compartidas al navegar entre servicios. Antes de editar se preparan checkouts
inicializados en worktrees aislados, desde los commits fijados por sus padres.
No se clonan submódulos automáticamente ni se actualizan gitlinks. Cada repo mantiene
sus pruebas y commits. `.worktreeinclude` copia archivos ignorados de setup al crear
el worktree y conserva sus cambios al continuar.

Cada conversación permanece vinculada a su proyecto. `regent_use_repo` permite navegar
entre servicios y submódulos del mismo proyecto o cambiar su perfil de ejecución,
pero rechaza otro proyecto independiente e indica abrir una conversación nueva
(un hilo nuevo en Slack; `regent_start` con `repo` desde MCP). Hacer `cd` no recarga
MCPs. Las conexiones y variables del agente parten
de la raíz del proyecto. Los entornos de ejecución de cada servicio siguen siendo
propios. El aislamiento de worktrees y los hooks no aíslan secretos a nivel del
sistema operativo: ejecuta solo repositorios confiables bajo la misma cuenta.

Para elegir el contexto inicial explícitamente en Slack, escribe `repo: ruta/al/repo`
en una línea y el pedido en la siguiente. En CLI usa `--repo`. Una ruta inválida no
cae silenciosamente al predeterminado. Otro proyecto mencionado por nombre o URL
se resuelve usando las instrucciones del contexto inicial.

Cada hilo normal y cada mensaje raíz de DM inicia una conversación independiente;
responde dentro del hilo para continuar o detenerla. Las salas solicitadas al bot
comparten contexto de canal, pero invitar a alguien no amplía `allowed_users`.
En canales y salas se necesita @mención, salvo respuestas a una pregunta pendiente
y comandos de control del autor. En DM no hace falta mencionar al bot.

Los mensajes normales usan `task`; Regent no clasifica su lenguaje ni impone etapas.
Claude interpreta el pedido con las instrucciones y skills del repositorio. Puedes elegir
`/ask`, `/patch`, `/task` o `/project` después de la mención, o enviar `intent` por MCP.
Estas opciones aplican sólo a ese mensaje; las continuaciones normales vuelven a `task`.
`ask` impone modo consulta; los demás perfiles seleccionan límites/modelos, no autorización
para cambiar código. `models.project` null usa `models.task`. El tramo final reserva hasta
60 segundos o el 20% del límite para responder; no amplía el timeout ni garantiza recuperar
una herramienta interrumpida.

## Operación

- `pnpm start` sirve Slack y, si está habilitado, MCP; `pnpm start:mcp` sirve solo MCP.
- El puerto predeterminado es `8788`, enlazado a `127.0.0.1`; `REGENT_HOST` cambia la
  dirección solo para contenedores que publican el puerto. El estado predeterminado
  está en `log/v2.sqlite`. [`.env.example`](../.env.example) muestra los overrides.
- Un solo runtime puede escribir en una base SQLite. Usa otra `REGENT_DB` para una
  CLI concurrente. No cambies la base existente durante una actualización.
- Slack usa Socket Mode. Para pruebas, usa una app separada: dos procesos con el
  mismo app token pueden repartirse eventos. El [manifiesto](../slack-manifest.json)
  define los scopes; reinstala la app tras cambiarlos para aprobarlos.
- `/healthz` muestra conexión, cola y entregas; `/metrics`, las ejecuciones por estado.
  `pnpm regent runs` y `pnpm regent tail <run_id> --follow` permiten inspeccionar trabajo.
- Las imágenes adjuntas de Slack requieren `files:read`: hasta cinco por turno,
  3 MiB por imagen y 10 MiB en total, en PNG/JPEG/GIF/WebP. Las URLs y páginas PDF
  no se convierten automáticamente en imágenes.
- El emisor se resuelve por workspace/user ID, con nombre y correo opcionales vía
  `users.info`. El dueño de una conexión no sustituye la identidad del solicitante;
  las asignaciones externas requieren un mapeo inequívoco.

Para credenciales de servicio compartidas entre proyectos, usa un entorno externo
privado del servicio, por ejemplo `~/.config/regent/agent-shared.env`, cargado mediante
`EnvironmentFile` en systemd. No lo añadas también al `.env` de Regent: sus claves se
retiran del entorno del agente salvo que las aporte el proyecto. Las variables del
repo sobrescriben las compartidas; las credenciales Slack siempre se retiran y la
API key del motor se conserva. Reinicia tras rotar credenciales. Cualquier script
ejecutado bajo esa cuenta puede acceder a su entorno; limita permisos en la fuente.

`pnpm test` verifica el comportamiento con procesos y proveedores simulados. Las
pruebas opt-in `REGENT_SMOKE=1 pnpm smoke` y
`REGENT_SMOKE=1 node test/smoke/project-smoke.mjs` usan Claude real y pueden consumir saldo;
la segunda verifica skills/MCP de raíz y dos submódulos. Ninguna sustituye probar la
instalación real en Slack o Desktop. Al migrar, elimina campos retirados que rechace
el esquema y usa la plantilla actual; no borres el historial SQLite.

## Proxy público

[examples/Caddyfile](../examples/Caddyfile) publica sólo MCP y sus rutas OAuth. Sustituye
el hostname y, si cambias `REGENT_PORT`, el puerto loopback. Las rutas internas de
herramientas, políticas, salud y métricas quedan sin publicar. El proxy y Regent deben
compartir el host o namespace de red para usar `127.0.0.1`. Valida la configuración de
tu proxy y comprueba que las rutas internas devuelvan 404 desde el dominio público.
Los previews de aplicaciones pertenecen al proveedor de hosting de cada proyecto.
Regent no aloja previews. Para actualizar una instancia anterior, elimina el bloque
`previews` de su YAML y las rutas del proxy que apuntaban a su antiguo gateway.
