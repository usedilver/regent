---
name: talently-code
description: Usa Talently Code para crear, modificar, eliminar o investigar funcionalidades en webs, aplicaciones y dashboards. Activa esta skill cuando pidan usar Talently Code, cambiar el footer de una web, corregir una pantalla, agregar una vista o grafico, o quitar una funcionalidad. Descubre el proyecto con regent_context y delega la implementacion al agente del servidor, que tiene acceso a los repositorios y sus herramientas. No aplica a consultas o analisis de datos aislados ni a acciones de negocio que no cambien una aplicacion.
---

# Talently Code

Esta skill conecta el pedido de negocio del chat con el agente que tiene acceso al
repositorio. No contiene reglas de ningun proyecto: esas instrucciones y skills
permanecen en el repo y las carga el ejecutor.

El usuario puede elegir **talently-code** desde el menu `/` de Claude Desktop o
pedir "usa Talently Code" y describir el resultado que necesita. Por ejemplo:
"Usa Talently Code y cambia la fecha del footer de la web de Talently".
En clientes que usan nombres completos de plugins, la entrada es
`/talently-code:talently-code`. Elegir la skill evita depender solamente de la
seleccion automatica del modelo. Presenta el servicio al usuario como Talently Code;
los nombres tecnicos `regent_*` corresponden al motor interno.

## Descubrir el destino

Busca y llama `regent_context` del conector Talently Code. Si el usuario indico un repo,
pasalo; si no, descubre el contexto disponible sin pedir rutas tecnicas al usuario.
Conserva el nombre de la aplicacion o URL del pedido al delegarlo, para que el ejecutor
resuelva ese destino antes de editar. El predeterminado no sustituye un proyecto indicado.
Si el destino sigue siendo ambiguo, aclara cual aplicacion quiere cambiar.

Explica en una frase que proyecto se encontro y que vas a revisar o cambiar alli.
No pidas al usuario nombres de tablas, rutas ni herramientas para poder continuar.
El repo predeterminado es un destino configurable, no prueba que todos los pedidos
pertenezcan a ese proyecto. Conserva un destino explicito o aclara una ambiguedad real.

Un pedido de crear un dashboard puede significar extender el dashboard existente.
Comprueba primero el contexto encontrado; no asumas que requiere otra app ni un
artefacto HTML aislado. Respeta un pedido explicito de crear algo independiente.

El inventario de contexto muestra archivos y conectores declarados, no confirma
su funcionamiento. La implementacion y sus comprobaciones pertenecen al ejecutor.
Si ese contexto ya responde la pregunta, responde directamente sin iniciar un trabajo.

## Delegar el trabajo

Llama `regent_start` con el pedido completo y su contexto de negocio, un UUID nuevo
en `request_id` y el repo elegido cuando corresponda. Reutiliza ese UUID solamente
para reintentar el mismo mensaje. `repo` omitido usa el predeterminado del servidor.

Indica el resultado solicitado y los limites del usuario: investigacion de solo
lectura, cambio local, pruebas, rama, PR o despliegue segun el alcance autorizado.
Pide que el agente lea las instrucciones y la skill del proyecto antes de editar.
No amplíes ese alcance ni impongas un flujo de aprobaciones propio de esta skill.
Conserva el pedido original: una pregunta breve no necesita una auditoria completa,
tablas de metadatos, una lista fija de severidades ni un informe de muchas secciones.
Solicita una respuesta de profundidad proporcional al pedido. Usa `intent: ask`
para consultas y revisiones de solo lectura; el ejecutor elige las herramientas
y las instrucciones del repo que realmente necesita.

Para este trabajo de codigo, no intentes primero conseguir en el chat las mismas
herramientas de BD que tiene el ejecutor. La ausencia de `database-mcp`, SQL o un
SDK en Desktop no prueba falta de acceso en Talently Code. Tampoco hace falta cargar
skills de analisis de otros plugins como requisito previo a enviar el pedido.
El ejecutor verifica sus lectores y conexiones y reporta las limitaciones reales.

## Seguir la conversacion

El seguimiento de este trabajo pertenece a esta conversacion. No crees tareas
programadas, recordatorios ni automatizaciones para revisar su avance, salvo que
el usuario pida expresamente una notificacion posterior. No anuncies revisiones
futuras que no puedas realizar dentro del seguimiento disponible.

Consulta `regent_get_run` con el `run_id` recibido y conserva su espera predeterminada
de hasta 20 segundos; no hagas un bucle de consultas inmediatas. Sigue `latest_run`,
porque un cambio de contexto puede crear una continuacion automatica. Cuando termine
o espere una respuesta humana, deja de consultar.

El seguimiento normal no usa tarjetas. Para una pregunta breve, basta el resultado
final: no anuncies cada herramienta, consulta de estado ni lectura de archivo. En
trabajos largos comunica solo avances relevantes o bloqueos, sin repetir que sigue
trabajando ni copiar las actividades internas del ejecutor.

Solo si el usuario pide un panel visual, llama `regent_show_progress` una vez para
esa conversacion. El mismo panel se actualiza; no lo abras de nuevo con cada consulta
ni dupliques su contenido en mensajes. Las consultas normales y las continuaciones
no crean otro panel. Si el cliente interrumpe el turno, conserva los IDs e informa
como retomar, sin programar nada.

Ante una pregunta pendiente, presentala al usuario y envia su respuesta mediante
`regent_continue`, conservando `conversation_id` y usando un UUID nuevo por mensaje.
Usa esa misma conversacion para cambios posteriores relacionados. Si el usuario
pide detenerse, `regent_cancel` pausa la conversacion y conserva codigo y cola.

Entrega el resultado confirmado por Talently Code: que cambio, donde revisarlo, validacion
y limites pendientes. No atribuyas a un fallo de conectores del chat un bloqueo que
el ejecutor no haya comprobado. Si Talently Code no esta disponible, explica que falta esa
conexion; no cambies silenciosamente a otro producto, datos de ejemplo o Supabase.
Responde primero lo que pregunto el usuario. No repitas el informe completo del
ejecutor si una conclusion breve con los hallazgos relevantes es suficiente.
