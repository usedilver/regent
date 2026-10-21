---
status: Accepted
date: 2026-10-20
author: Dilver
---

# Regent MCP: plan de ejecucion y progreso

## Objetivo

Crear, modificar y eliminar codigo desde Claude Desktop utilizando el motor existente
de Regent. El primer proyecto de uso es Talently Dashboards; Regent conserva su
caracter generico y las reglas particulares permanecen en cada repositorio.

Este documento local fue solicitado para seguir esta entrega. No introduce un tablero,
una aprobacion obligatoria ni tareas de negocio en Regent. Los pendientes de operacion
se distinguen de las pruebas locales; una simulacion no certifica el uso en produccion.

## Arquitectura

```text
Claude Desktop -- MCP stdio --> conector local -- HTTPS /mcp --> Regent Core
                                                            --> Claude Code CLI
                                                            --> repo / skill / MCPs
                                                            --> worktree de conversacion
```

Desktop puede mantener conectado el Data MCP para analizar datos. Regent utiliza los
MCP y el entorno configurados en el repositorio seleccionado para ejecutar sus cambios.
No se agrega edicion de codigo a `talently-data-mcp` ni se modifica su warehouse.

`src/mcp.ts` implementa el adaptador externo. El mismo Core conserva colas, sesiones,
limites, uso y cancelacion. `src/mcp-output.ts` separa las salidas: un trabajo MCP no
publica mensajes en Slack. `pnpm start` puede servir ambas entradas en un proceso;
`pnpm start:mcp` funciona sin conectar Slack ni requerir sus tokens.

El MCP interno `/tools` permanece reservado al agente de un run activo. Su bearer
temporal no permite iniciar trabajos externos y los tokens externos no autorizan
herramientas internas. El cliente stdio usa el SDK MCP ya instalado, sin otro agente
ni otra dependencia. Desktop coordina y Claude Code ejecuta el codigo en el servidor.

## Herramientas de la primera entrega

| Herramienta | Entrada principal | Resultado |
| --- | --- | --- |
| `regent_context` | `repo` opcional | Repo predeterminado/seleccionado e inventario de instrucciones, skills, agentes y MCP declarados; no ejecuta el modelo |
| `regent_start` | `prompt`, `request_id` UUID, `repo` e `intent` opcionales | `conversation_id`, `run_id`; comienza sin esperar a terminar el trabajo y usa el repo predeterminado si se omite |
| `regent_get_run` | `run_id` | Estado, resultado, ultimo run, actividades reales, progreso y pregunta pendiente; panel MCP Apps con refresco automatico |
| `regent_continue` | `conversation_id`, `prompt`, UUID nuevo en `request_id` | Nuevo run en la misma sesion, repo y worktree |
| `regent_cancel` | `conversation_id` | Pausa la conversacion, detiene el proceso activo y conserva codigo y cola |

Usar el mismo `request_id` para reintentar el mismo mensaje evita duplicar trabajo.
El primer mensaje aceptado para ese identificador es el que se ejecuta. Un mensaje
nuevo requiere otro UUID. `regent_start`, `regent_continue` y `regent_get_run`
anuncian el recurso `ui://regent/progress.html`. En clientes con MCP Apps, el panel
consulta el estado cada 3 segundos dentro del chat; no necesita tareas programadas
ni mantener al modelo consultando. Se detiene al terminar, esperar respuesta humana,
cerrar el panel o fallar tres veces consecutivas; tiene reintento manual. Un cambio
interno de repo crea otro run y el panel sigue `latest_run`.

Sin soporte de panel, el cliente consulta `regent_get_run` en el mismo turno y conserva
los IDs si el turno termina. No programa recordatorios ni promete revisiones futuras
sin que el usuario las pida. La skill y las instrucciones MCP lo indican expresamente.

En `waiting_human`, Desktop presenta la pregunta y envia la respuesta con
`regent_continue`. Una cancelacion conserva los mensajes pendientes: continuar
reanuda esos mensajes antes del nuevo. Los resultados extensos se limitan a 60000
caracteres y se indica `result_truncated`; pedir un resumen en la misma conversacion
si hace falta. La recuperacion tras reinicio marca el trabajo activo como interrumpido,
conserva su sesion y espera una continuacion explicita.

Los prompts determinan el resultado pedido: analisis, cambios, pruebas, rama o PR.
El adaptador no impone publicaciones ni merges y no interpreta crear/eliminar un
grafico como permiso para escribir registros de negocio en la base de datos.

## Configuracion del servidor

La configuracion existente sigue funcionando: MCP esta deshabilitado por defecto.
Agregar al YAML privado de la instancia:

```yaml
mcp:
  enabled: true
  principals:
    - id: dilver
      token_env: REGENT_MCP_TOKEN_DILVER
```

Guardar `REGENT_MCP_TOKEN_DILVER` en el entorno privado del servicio: un token aleatorio
de al menos 32 caracteres, diferente de las credenciales de Claude, Slack o GitHub.
No poner su valor en el YAML, el repo ni los prompts. Configurar un principal y token
distintos por persona. La identidad se obtiene del bearer, nunca de un email o ID
propuesto por el modelo. Reiniciar despues de rotar, agregar o revocar tokens.

Los principales MCP tienen acceso al workspace `repos.path` / `workspace_root` y solo
pueden consultar, continuar o detener sus propias conversaciones MCP. No heredan la
lista de usuarios de Slack. Los tokens de transporte configurados se eliminan del
entorno del agente incluso si un `.env` del repo intentara reintroducirlos.
Se mantienen los permisos del runtime existentes: el worktree no es un sandbox del SO.

El servidor escucha en `127.0.0.1`, puerto `REGENT_PORT` (8788 por defecto). Para una
instancia remota, usar HTTPS con un reverse proxy que publique solamente `/mcp`, o un
tunel SSH con verificacion normal del host. No publicar `/tools`, `/hook-denial` ni
`/tool-policy`. Se rechazan peticiones con `Origin`; no hay cliente web directo.

Elegir un modo de servicio:

- Servicio existente con Slack: `pnpm start`; con `mcp.enabled: true` atiende ambos.
- Instancia solo MCP: `pnpm start:mcp`; conserva el mismo formato de config, sin
  requerir conexion Slack. Sus campos Slack pueden conservarse sin usarse.

No iniciar dos procesos con la misma `REGENT_DB`. Con ambas entradas en el servicio
existente hay una sola cola, limite de concurrencia y lease. Las colas de CLI no son
ejecutadas por el servicio Slack/MCP. No borrar ni reemplazar `log/v2.sqlite`.

## Configuracion de Claude Desktop

Esta entrega usa un servidor MCP local por stdio que se conecta al runtime remoto.
No es aun un conector remoto OAuth instalable solamente con una URL.

Instalar las dependencias del checkout local de Regent con `pnpm install --frozen-lockfile`.
Agregar una entrada al archivo de configuracion MCP de Claude Desktop, conservando
las entradas existentes. En macOS normalmente esta en
`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "regent": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/regent/src/mcp-client.ts"],
      "env": {
        "REGENT_MCP_URL": "https://your-regent-host.example/mcp",
        "REGENT_MCP_TOKEN": "YOUR_PERSONAL_REGENT_TOKEN"
      }
    }
  }
}
```

Usar Node 22.20+ y rutas absolutas; la app Desktop puede tener otro PATH. Este archivo
es privado y contiene el token personal. El conector no escribe logs en stdout porque
stdout transporta MCP. HTTPS es obligatorio salvo HTTP hacia loopback, util para un
servidor local o tunel. No acepta credenciales ni tokens dentro de la URL.

Reiniciar Desktop y comprobar que aparecen las cinco herramientas. Ejemplo:

> En el repo `talently-code/data/talently-dashboards`, crea un grafico semanal de
> ofertas publicadas. Sigue su skill, conserva el cache por card y abre un PR con
> las pruebas realizadas. No hagas merge ni despliegue.

Claude puede descubrir el repo mediante `regent_context`, genera un UUID para el mensaje,
llama `regent_start`, consulta el estado y
devuelve el resultado. Para editar o eliminar ese grafico puede continuar la misma
conversacion. La ruta del repo es relativa al workspace del servidor, no al Mac.

## Plan y progreso

| Etapa | Estado | Evidencia / criterio de cierre |
| --- | --- | --- |
| Revisar Core, runner, persistencia y MCP interno | Completada | Reutilizacion definida sin acoplar reglas de dashboards al adaptador |
| Adaptador MCP externo y autenticacion | Implementada | `src/mcp.ts`; principales propios, deduplicacion y propiedad de conversaciones |
| Ejecucion compartida y modo sin Slack | Implementada | `src/server.ts`, `src/mcp-server.ts`, filtros de cola/recuperacion por adaptador |
| Conector stdio para Desktop | Implementada | `src/mcp-client.ts`; transporte HTTP autenticado con HTTPS/loopback |
| Pruebas locales del adaptador | Completada | 14 escenarios aprobados; SDK real, HTTP/stdio reales, descubrimiento de contexto, SQLite reabierto y CRUD simulado en un worktree Git real |
| Regresion completa | Completada | `pnpm test` aprobado, incluida la suite MCP; `git diff --check` sin errores |
| Arranque local y configuracion para Claude Code | Completada | Node 22.20.0, Claude Code 2.1.305, endpoint loopback autenticado y cuatro herramientas verificadas usando el conector stdio; sin ejecutar trabajos |
| Instalar configuracion local de Claude Desktop | Completada | Entrada `regent` agregada al JSON privado conservando los conectores anteriores; catalogo actualizado cargado y herramientas verificadas desde la interfaz |
| Descubrimiento y delegacion desde el chat | Implementada | Instrucciones MCP reenviadas por stdio, herramienta de contexto y repo opcional; descubrimiento e inicio de run verificados desde Desktop con la skill del cliente |
| Skill de delegacion del cliente Desktop | Implementada | Instalada originalmente como `regent-code`; su fuente se movio a `client-plugin/skills/trabajar/SKILL.md` al agrupar el plugin |
| Progreso dentro del chat | Parcial | Actividades de Slack reutilizadas, recurso MCP Apps y puente stdio extendido; suite completa aprobada, validacion visual/activacion local pendientes |
| Plugin del cliente | Parcial | Manifiesto, skill `trabajar`, MCP HTTP configurable y ZIP sin secretos; validacion del formato aprobada, instalacion integrada en Desktop pendiente |
| Smoke real de contexto en local | Completada | Run `937a3eb0-cd01-49c6-b08b-29b5d35bda24`: Claude Code real, skill local y archivos AGENTS leidos; sin cambios de codigo ni consultas de candidatos |
| Configurar y actualizar instancia AWS | Pendiente | Publicar codigo revisado, habilitar principales y verificar endpoint sin revelar tokens |
| Preparar repositorio Dashboards en el servidor | Pendiente | Checkout actualizado, skill disponible y fuentes/MCP del repo configurados |
| Smoke desde la app Claude Desktop | Parcial | Descubrir, iniciar y consultar completados en run `7aafe10b-b0cf-46a4-9cee-f7a1b491125e`; continuar y cancelar aun sin probar desde la interfaz |
| Validar crear, modificar y eliminar un grafico | Pendiente | Cambios revisables en worktree/PR, pruebas del dashboard y fuente real configurada |

Los tests no certifican produccion. La prueba real de Desktop queda limitada a
descubrimiento, inicio y lectura del resultado; no valida CRUD de dashboards ni
despliegues. La instancia AWS no se actualizo.

## Prueba local preparada

El 2026-10-20 se inicio el runtime local en `http://127.0.0.1:8788/mcp`, con
configuracion propia `config/regent-mcp-local.yaml` y base `log/mcp-local.sqlite`.
El workspace autorizado de esta prueba es el checkout local de `talently-code` y
el repo predeterminado es `data/talently-dashboards`. La configuracion original de
la instancia no fue modificada.

Los archivos privados generados para esta maquina estan ignorados por Git:

- `config/start-mcp-local.sh`: inicia el runtime con su config, puerto y base locales.
- `config/mcp-local-server.env` y `config/mcp-local-client.env`: token del servidor
  y conexion del cliente, ambos con permisos `600`.
- `config/claude-code-mcp-local.json`: entrada MCP por stdio con rutas absolutas
  a Node y al archivo de entorno; no incluye el valor del token.

Para abrir Claude Code con esa configuracion sin modificar los servidores globales:

```sh
claude --mcp-config /absolute/path/to/regent/config/claude-code-mcp-local.json
```

Comprobar la conexion mediante `/mcp`. La verificacion automatica local inicializo
el cliente y listo las cuatro herramientas contra el proceso real del servidor;
tambien comprobo rechazo `401` sin token. Esa primera verificacion no envio solicitudes
`regent_start` ni ejecuto el modelo. La seccion de diagnostico documenta el smoke real
posterior y la siguiente seccion registra la delegacion verificada desde Desktop.

Tambien se agrego la misma entrada stdio al archivo privado de Claude Desktop en
`~/Library/Application Support/Claude/claude_desktop_config.json`, preservando los
conectores y preferencias existentes y guardando un backup privado. Se verifico el
transporte usando esa entrada exacta. Desktop cargo el catalogo actualizado y se
verifico su interfaz en las pruebas descritas mas abajo.

El formulario "Agregar conector personalizado" agrega conexiones remotas desde
Anthropic y no accede al loopback de esta maquina. Para esta prueba local se utiliza
la configuracion de la app Desktop; no se publica el runtime mediante un tunel publico.

## Contexto, prioridades y diagnostico de la delegacion

El chat anfitrion y el agente ejecutor no comparten automaticamente su catalogo de
herramientas ni sus skills. La inicializacion MCP ahora informa al chat de que Regent
puede trabajar en el repo predeterminado y comprobar sus fuentes. El puente stdio
reenvia esas instrucciones y las descripciones de herramientas incluyen el nombre
del proyecto para facilitar su descubrimiento. `regent_context` devuelve solo un
inventario: no afirma que cada skill se haya invocado ni que una conexion funcione.

La seleccion del contexto sigue este orden operativo:

1. `repo` explicito del pedido; si se omite, `repos.default_repo` de la instancia.
   El destino se valida contra el workspace, incluidas las rutas resueltas por symlink.
2. Core carga el entorno del repo seleccionado y arranca Claude Code alli, con un
   worktree propio. El entorno usa `repos.agent_env_files` si se configuro; en caso
   contrario usa el `.env` de ese repo. No copia automaticamente el `.env` del padre.
3. El CLI recibe `--setting-sources user,project,local` y el protocolo generico de
   Regent. Las instrucciones propias del repo definen arquitectura y workflow; para
   un cambio existente se usan antes que un flujo generico de scaffolding.
4. `CLAUDE.md` puede enlazar a `AGENTS.md`. Las instrucciones de ancestros se acumulan;
   las especificas del proyecto y las subcarpetas aportan su contexto. Una skill
   carga su cuerpo cuando se usa, no por el solo hecho de aparecer en el catalogo.
5. La skill canonica puede vivir dentro del submodulo en `.agents/skills/`, expuesta
   al CLI mediante `.claude/skills/`. No necesita moverse al monorepo para Regent.
6. Un cambio a otro repo requiere `regent_use_repo`, con handoff y sesion nueva;
   `cd` por si solo no recarga el entorno ni los MCP. La respuesta vuelve por MCP
   y el cliente consulta su estado; esta conversacion no publica en Slack.

El 2026-10-20, ante una respuesta de Desktop afirmando no tener la BD de Talently,
se comprobo que el runtime local tenia cero runs: el log de Desktop solo mostraba
`initialize` y `tools/list`. No habia un fallo de acceso al submodulo en esa
conversacion: el chat no habia llamado a Regent y seguia sus propios plugins.

Despues se ejecuto el smoke real de solo lectura indicado en la tabla. El evento
`init` y las lecturas registradas comprobaron:

- Cwd dentro del worktree de `data/talently-dashboards`.
- `new-dashboard` presente en el catalogo nativo del CLI y su SKILL.md leido, junto
  con `AGENTS.md` y `app/AGENTS.md` del proyecto.
- `database-prod`, `database-test` y el MCP interno `regent` reportados como
  conectados. No se ejecutaron consultas de negocio; conexion no equivale a una
  validacion de una consulta concreta ni de la frescura de los datos.
- El subagente `data-analyst` esta declarado en el padre, pero no aparece como tipo
  disponible en esta sesion del submodulo. `AGENTS.md` no es una declaracion de
  subagente. No se copiaron agentes ni se hizo obligatorio un analista para crear vistas.
- El agente identifico correctamente que debe extender el Next existente, no crear
  otra app. El worktree de diagnostico quedo limpio y no se hizo commit ni despliegue.
  Los worktrees nativos se excluyeron mediante el exclude local de Git, sin modificar
  el `.gitignore` versionado del dashboard.

Para futuras investigaciones, `log/mcp-local.log` registra herramienta, principal y
resultado de las llamadas MCP, sin prompts ni tokens. SQLite conserva runs y eventos;
`init` incluye cwd, skills, agentes y herramientas efectivamente anunciadas por el CLI.
Un inventario de archivos y el catalogo real de una ejecucion son evidencias distintas.

Referencias del CLI: [carga de instrucciones](https://code.claude.com/docs/en/memory)
y [skills de proyecto](https://code.claude.com/docs/en/skills).

## Skill del cliente y reproduccion desde Desktop

Una segunda prueba desde la app confirmo que las instrucciones del servidor y sus
descripciones no bastaban para que el modelo eligiera Regent en un pedido generico
de dashboard. El chat seguia leyendo el plugin `talently-data` bajo `/mnt/skills/`
y buscaba su conector de SQL, aunque Regent estaba habilitado. Una llamada explicita
a `regent_context` desde la misma interfaz funciono y devolvio el repo y su skill.
El fallo pendiente era de seleccion de herramientas en el anfitrion.

Se agrego `client-skills/regent-code/SKILL.md` para ese cliente. Esta guia generica
descubre el repo, delega el pedido completo, consulta resultados y mantiene el alcance
del usuario. No copia reglas del dashboard ni cambia el plugin de datos. Se importo
su ZIP en Personalizacion > Skills y se verifico el switch habilitado. El paquete
contiene solamente `regent-code/SKILL.md`, sin scripts ni credenciales.

En un chat nuevo se probo un pedido de dashboard de Talently sin mencionar Regent,
limitado a revisar el proyecto sin consultas ni cambios. Desktop eligio
`regent_context` y mostro `data/talently-dashboards` y `new-dashboard`, en lugar de
intentar primero el SQL del plugin de datos. Es una comprobacion de ese caso real,
no una garantia determinista de seleccion para cualquier frase o contexto.

La continuacion de esa revision llamo `regent_start` y `regent_get_run` desde la
interfaz, con permisos concedidos una vez, sin habilitar permisos permanentes.
El run `7aafe10b-b0cf-46a4-9cee-f7a1b491125e` termino `completed`: el ejecutor leyo
el cuerpo de `new-dashboard`, cito una regla concreta y Desktop mostro el resultado.
Los eventos registran solo `cat` del SKILL.md y `ls` de sus referencias; no hubo
consultas de datos ni herramientas de escritura. El worktree quedo limpio. Regent
crea su worktree aislado al iniciar incluso cuando el pedido es de solo lectura.
La captura local `tmp/regent-desktop-proof.png` conserva la respuesta de la app;
los artefactos de prueba no se versionan. Continuar/cancelar desde la UI y el CRUD
real siguen pendientes; no se infieren de este smoke de lectura.

El artefacto independiente de esta prueba permanece en `tmp/regent-code-skill.zip`
(ignorado). Su fuente paso a `client-plugin/skills/trabajar/SKILL.md`. La instalacion
independiente de Desktop se conserva hasta probar el plugin integrado, para no
reemplazar una conexion verificada por un paquete que aun no tiene endpoint remoto.
`new-dashboard` permanece en el repo del dashboard y su cuerpo lo lee el ejecutor.

## Plugin del cliente y fiabilidad para el equipo

`client-plugin/` agrupa la skill y la declaracion HTTP de Regent. El manifiesto pide
endpoint y token personal con `userConfig`, marcando el token como sensible. El ZIP
se genera con `pnpm plugin:pack` mediante una lista explicita de archivos: manifiesto,
MCP, skill, guia y licencia. No contiene entornos, tokens, runtime ni rutas de esta
maquina. La fuente del protocolo del ejecutor continua en `plugin/`; son paquetes
distintos y el ejecutor no carga este plugin de delegacion como su protocolo.

El flujo tiene tres decisiones diferentes:

1. **Entrada del cliente.** Elegir la skill o `/regent:trabajar` carga la guia de
   delegacion explicitamente. La seleccion por texto libre sigue siendo del modelo,
   incluso dentro de un plugin; no es una regla ejecutada por el runtime.
2. **Destino del servidor.** `repo` explicito prevalece; sin el se usa
   `repos.default_repo`. En la prueba local es `data/talently-dashboards`. El default
   no obliga a Desktop a llamar Regent ni sustituye resolver un proyecto ambiguo.
3. **Implementacion.** `plugin/colleague.md` se agrega al prompt de Claude Code
   despues de aceptar el trabajo. Tiene guia generica de contexto, no un selector
   especial de dashboards. Las skills y fuentes del proyecto elegido definen el
   cambio concreto. Cambiar este prompt no repara una llamada que nunca llego.

La autenticacion, propiedad de conversaciones, validacion de rutas y deduplicacion
se ejecutan en codigo y tienen pruebas automatizadas. La eleccion del flujo por el
modelo y que cada resultado satisfaga el pedido necesitan evaluacion real. Actualmente
los principales autorizados tienen acceso al workspace configurado; no existen
listas de repos permitidos por persona. El default es un destino, no una barrera
de permisos. Para una instancia dedicada a un solo proyecto, limitar su workspace
al propio repo reduce el alcance sin introducir reglas de negocio en Regent.

El ZIP extraido y la skill pasan sus validadores; se comprobo integridad y salida
reproducible. Los avisos de icono y politica de privacidad corresponden al directorio
publico, donde este paquete no se ha presentado. Estas comprobaciones no validan
la pantalla `userConfig` de Desktop ni su conexion. No se instala ni anuncia al
equipo como reemplazo completo todavia.

Para completar esa entrega faltan el endpoint remoto accesible desde Anthropic y
su autenticacion de cliente. Luego hay que probar en un cliente limpio la instalacion,
entrada explicita, pedido natural, proyecto ambiguo, seguimiento y reconexion tras
interrupcion, asi como el cambio real de dashboard con sus pruebas. Solo entonces
retirar la skill independiente y el conector de prueba duplicados. No se abrio un
tunel ni se desplego AWS como parte de este empaquetado.

Referencia de compatibilidad: [plugins con MCP local y remoto](https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors).
Configuracion: [manifiesto y userConfig](https://code.claude.com/docs/en/plugins-reference).

## Progreso en Claude y tareas programadas

El 2026-10-21 Desktop envio el trabajo de candidatos a Regent y creo revisiones
programadas por su cuenta. La skill instalada, leida desde su copia sincronizada,
indicaba consultar `regent_get_run`, pero no crear automatizaciones. El adaptador
solo devolvia el ultimo `mcp_notice`; no exponia las actividades que Slack mostraba.

Se agrego `mcp-activities.ts`, que reconstruye el mismo resumen de `activities.ts`
a partir de eventos persistidos, aun despues de reabrir SQLite. No envia argumentos
arbitrarios ni resultados crudos de herramientas al panel. La propiedad del run se
valida antes de leer las actividades. Un error de herramienta conserva su estado;
un turno terminado no convierte operaciones sin confirmar en exitosas.

`mcp-progress.ts` registra el recurso autocontenido y `mcp-progress-app.ts` presenta
los checks, la pregunta o el resultado. El SDK oficial MCP Apps 1.1.2 es compatible
con el SDK MCP 1.x de Regent; esbuild empaqueta el recurso en memoria al primer uso.
No hay llamadas directas a un dominio externo desde el iframe: se usa el puente de
herramientas del host y su autenticacion. No hay tokens en el HTML. El transporte
stdio ahora reenvia listado y lectura de recursos, ademas de herramientas.

Las nuevas pruebas verifican transiciones en curso/completadas/error, aislamiento
entre principales, relectura persistida, omision de datos crudos y recursos por
HTTP/stdio. `pnpm test` paso completo. El formato MCP Apps no reproduce las tarjetas
nativas de Slack: presenta una tarjeta propia de Regent en clientes compatibles.
La apariencia y el polling dentro de Desktop deben verificarse en su interfaz;
la prueba de transporte no certifica esa visualizacion.

La ejecucion activa de candidatos no se reinicia para activar esta entrega. Su
skill instalada y el runtime se actualizaran al cerrar el trabajo, conservando su
sesion y worktree. Las tareas programadas ya creadas por Claude no se borraron.
Referencia: [MCP Apps](https://apps.extensions.modelcontextprotocol.io/api/documents/Quickstart.html).

## Fuera de esta entrega

OAuth para un conector remoto de una sola URL, permisos por repositorio dentro de un
workspace, enlaces automaticos entre conversaciones Slack/Desktop, editor visual y
cambios en el warehouse. Se pueden agregar despues sin mezclar el MCP de datos con
el ejecutor de codigo.
