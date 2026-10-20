---
name: regent-code
description: Crea, modifica o elimina codigo en proyectos existentes mediante Regent. Usar para pedidos como crear un dashboard para una empresa, agregar una vista o grafico, cambiar una pantalla, corregir una app o quitar una funcionalidad cuando el cliente tiene conectado Regent. Primero descubre el repositorio con regent_context y delega la implementacion al agente del servidor. No aplica a una consulta de datos, un reporte o una visualizacion aislada que no requiera cambiar una aplicacion.
---

# Crear y modificar proyectos con Regent

Esta skill conecta el pedido de negocio del chat con el agente que tiene acceso al
repositorio. No contiene reglas de ningun proyecto: esas instrucciones y skills
permanecen en el repo y las carga el ejecutor.

## Descubrir el destino

Busca y llama `regent_context` del conector Regent. Si el usuario indico un repo,
pasalo; si no, descubre el predeterminado sin pedir rutas tecnicas al usuario.
Si el destino sigue siendo ambiguo, aclara cual aplicacion quiere cambiar.

Un pedido de crear un dashboard puede significar extender el dashboard existente.
Comprueba primero el contexto encontrado; no asumas que requiere otra app ni un
artefacto HTML aislado. Respeta un pedido explicito de crear algo independiente.

El inventario de contexto muestra archivos y conectores declarados, no confirma
su funcionamiento. La implementacion y sus comprobaciones pertenecen al ejecutor.

## Delegar el trabajo

Llama `regent_start` con el pedido completo y su contexto de negocio, un UUID nuevo
en `request_id` y el repo elegido cuando corresponda. Reutiliza ese UUID solamente
para reintentar el mismo mensaje. `repo` omitido usa el predeterminado del servidor.

Indica el resultado solicitado y los limites del usuario: investigacion de solo
lectura, cambio local, pruebas, rama, PR o despliegue segun el alcance autorizado.
Pide que el agente lea las instrucciones y la skill del proyecto antes de editar.
No amplíes ese alcance ni impongas un flujo de aprobaciones propio de esta skill.

Para este trabajo de codigo, no intentes primero conseguir en el chat las mismas
herramientas de BD que tiene el ejecutor. La ausencia de `database-mcp`, SQL o un
SDK en Desktop no prueba falta de acceso en Regent. Tampoco hace falta cargar
skills de analisis de otros plugins como requisito previo a enviar el pedido.
El ejecutor verifica sus lectores y conexiones y reporta las limitaciones reales.

## Seguir la conversacion

Consulta `regent_get_run` con el `run_id` recibido. Sigue `latest_run`, porque un
cambio de contexto puede crear una continuacion automatica. Si esta en cola o
ejecutando, da un estado breve sin afirmar que el trabajo ya termino.

Ante una pregunta pendiente, presentala al usuario y envia su respuesta mediante
`regent_continue`, conservando `conversation_id` y usando un UUID nuevo por mensaje.
Usa esa misma conversacion para cambios posteriores relacionados. Si el usuario
pide detenerse, `regent_cancel` pausa la conversacion y conserva codigo y cola.

Entrega el resultado confirmado por Regent: que cambio, donde revisarlo, validacion
y limites pendientes. No atribuyas a un fallo de conectores del chat un bloqueo que
el ejecutor no haya comprobado. Si Regent no esta disponible, explica que falta esa
conexion; no cambies silenciosamente a otro producto, datos de ejemplo o Supabase.
