# Configuración de la instancia

[Volver al README](../README.md). Esta página es una referencia para quien administra
Regent. El código y [regent.example.yaml](regent.example.yaml) definen los campos
admitidos y sus valores predeterminados.

## Archivos

| Archivo | Uso | En Git |
| --- | --- | --- |
| `regent.yaml` | Configuración activa | No |
| `regent.example.yaml` | Plantilla de configuración | Sí |
| `communication.md` | Reglas personalizadas de comunicación | No |
| `communication.example.md` | Comunicación predeterminada y plantilla | Sí |

Crea la instancia con `pnpm regent setup --repo /ruta/al/proyecto --team T_ID --user U_ID`.
El setup no sobrescribe archivos ni valida conexiones; `--workspace` amplía la
carpeta de proyectos y `--user` puede repetirse. También puedes copiar la plantilla.
Slack y MCP leen `config/regent.yaml`; `REGENT_CONFIG` permite elegir otro archivo.
`regent.example.yaml` no se carga como configuración activa.

Los secretos del servidor van en `.env`, el estado en `log/` y los auxiliares locales
o respaldos en `tmp/local/`. Conserva la base SQLite al actualizar la instancia.

## Active Settings

| Ajuste | Comportamiento |
| --- | --- |
| `name` | Nombre visible del MCP; no cambia el perfil de la app de Slack ni los identificadores `regent_*`. |
| `auth.mode` | `indie` usa el login local de Claude Code; `team` requiere `ANTHROPIC_API_KEY`. Autentica el motor, no a quienes llaman al MCP. |
| `slack.workspace_team_id` / `allowed_users` | Workspace y usuarios autorizados. Una lista vacía permite miembros activos verificados, excluyendo bots. |
| `repos.path` / `workspace_root` / `default_repo` | Proyectos accesibles y contexto inicial. El predeterminado es relativo al workspace; no sustituye un destino explícito. |
| `repos.agent_env_files` | Archivos de entorno para el agente. Vacío carga el `.env` de la raíz del proyecto seleccionado. |
| `repos.readonly_mcp` | Restricciones adicionales del hook; usa también credenciales de solo lectura en la fuente. |
| `permission_mode` | `bypass` omite los permisos nativos; `native` respeta `allow/ask/deny` y puede denegar solicitudes en modo headless. Los hooks no son un sandbox. |
| `slack.progress_mode` | `auto` para actividades; `plain` para texto actualizado. |
| `communication.instructions_file` | Archivo de comunicación personalizado; se explica abajo. |
| `models` / `limits` | Modelo, concurrencia, duración, inactividad y cancelación por perfil. |
| `budget` | Límites por ejecución y usuario en modo `team`; no limitan una suscripción personal. |
| `session.idle_reset_hours` | Reinicio de sesiones inactivas elegibles; no elimina su historial. |
| `mcp` | Habilitación del endpoint externo y acceso mediante OAuth o tokens técnicos. |

Usa `indie` para el operador individual y `team` para uso compartido. El modo individual
advierte ante acceso abierto o varios usuarios, pero no bloquea el arranque. La
configuración no sustituye las condiciones del proveedor; consulta [contribuciones](../CONTRIBUTING.md).

## Communication Policy

`plugin/colleague.md` define el protocolo de ejecución; cada repositorio aporta sus
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
omisión usa `communication.example.md`. Un archivo explícito debe ser legible,
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
      allowed_emails:
        - authorized.person@example.com
```

1. Registra `https://code.example.com/oauth/callback` en el proveedor y guarda su
   secreto en la variable indicada, dentro de `.env`.
2. Configura los callbacks del cliente y los correos autorizados, sin comodines.
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
Cambiar usuarios o callbacks requiere reiniciar; revocar acceso no cancela un
trabajo que ya está ejecutándose.

Como alternativa, `mcp.principals` vincula un ID a una variable `REGENT_MCP_TOKEN_*`.
Usa tokens distintos de al menos 32 caracteres; reinicia para rotarlos. Los trabajos
creados con un token no se reasignan al migrar esa persona a OAuth.

## Proyectos y ejecución

Los submódulos Git pertenecen a su proyecto raíz y conservan las conexiones y skills
compartidas al navegar entre servicios. Antes de editar se preparan checkouts
inicializados en worktrees aislados, desde los commits fijados por sus padres.
No se clonan submódulos automáticamente ni se actualizan gitlinks. Cada repo mantiene
sus pruebas y commits. `.worktreeinclude` copia archivos ignorados de setup al crear
el worktree y conserva sus cambios al continuar.

Un proyecto independiente carga su propio contexto mediante `regent_use_repo` y una
nueva sesión; hacer `cd` no recarga MCPs. Las conexiones y variables del agente parten
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

El router selecciona `ask`, `patch`, `task` o `project`. Puedes forzarlo con `/ask`,
`/patch`, `/task` o `/project` después de la mención. Las continuaciones breves heredan
el perfil; `models.project` null usa `models.task`. El perfil cambia tiempo/modelo,
no autorización. El tramo final reserva hasta 60 segundos o el 20% del límite para
responder; no amplía el timeout ni garantiza recuperar una herramienta interrumpida.

## Operación

- `pnpm start` sirve Slack y, si está habilitado, MCP; `pnpm start:mcp` sirve solo MCP.
- El puerto predeterminado es `8788`, enlazado a `127.0.0.1`. El estado predeterminado
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
`REGENT_SMOKE=1 node test/project-smoke.mjs` usan Claude real y pueden consumir saldo;
la segunda verifica skills/MCP de raíz y dos submódulos. Ninguna sustituye probar la
instalación real en Slack o Desktop. Al migrar, elimina campos retirados que rechace
el esquema y usa la plantilla actual; no borres el historial SQLite.

## Previews temporales

`previews: null` los deshabilita. Configurarlos habilita `regent_preview` en el
agente de Slack/MCP: reserva puerto, inicia la app con Bash en su worktree y publica
con el PID de un grupo de procesos independiente. No ejecuta comandos por fuera de
los permisos del repositorio. Se conserva un preview por conversación, incluso al
reiniciar Regent, hasta detenerlo o vencer su plazo.

```yaml
previews:
  domain: preview.example.com
  listen_port: 8791
  port_min: 32000
  port_max: 32009
  max_active: 3
  ttl_minutes: 120
  forward_cookie_names: [app_session]
  auth:
    cookie_name: app_session
    verify_url: https://api.example.com/auth/me
    login_url: https://app.example.com/login
    email_claim: result.email
    required_claims: {success: true, result.has_verified_email: true}
    allowed_email_domains: [example.com]
```

El verificador recibe solo `Authorization: Bearer` con el token JWT opaco de la
cookie (se acepta el formato JSON/URI de Nuxt). No decodifica claims del JWT para
autorizar: valida el resultado del servicio, los claims requeridos y el dominio del
correo. No guarda decisiones de acceso entre peticiones; agrupa verificaciones
simultáneas del mismo token. El login y la cookie pertenecen al servicio existente.

El gateway escucha solo en loopback. Caddy publica HTTPS para el dominio y
`*.preview.example.com`, enviándolo al gateway. Para certificados por host con
On-Demand TLS, configura `ask http://127.0.0.1:8791/_regent/tls`; solo autoriza
hostnames registrados, publicados y vigentes. DNS wildcard no proporciona por sí
solo un certificado wildcard: el modo por host está sujeto a límites de la CA.

El puerto de la app permanece interno. HTTP y WebSocket requieren sesión. Solo
se reenvían las cookies autorizadas; se descartan Authorization y cookies que
intenten escribirse con Domain. No es un sandbox: aloja solo proyectos confiables,
especialmente si comparten el dominio de cookies de una aplicación corporativa.
Cada app conserva su autorización y puede requerir configurar orígenes de desarrollo.

Los previews son temporales y no reemplazan el despliegue del PR. Los procesos
publicados deben tener su propio grupo (por ejemplo, `setsid` en Linux). La limpieza
solo termina grupos con PID, fecha de inicio y worktree verificados; no mata un PID
reutilizado. El supervisor debe permitir que esos procesos sobrevivan al reinicio
del runtime y Regent debe volver a arrancar para efectuar su limpieza pendiente.
