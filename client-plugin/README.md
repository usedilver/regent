---
updated: 2026-10-20
---

# Regent para Claude

Este plugin reune la conexion a Regent y la skill para crear, modificar o investigar
aplicaciones. El agente ejecutor trabaja en el servidor, lee las instrucciones del
proyecto elegido y devuelve el resultado a Claude. No incluye codigo de negocio ni
credenciales de ninguna persona.

## Uso

Instala el ZIP proporcionado por el administrador. Configura el endpoint y tu token
personal en los campos privados del cliente que soporte `userConfig`; no pegues el
token en una conversacion. La pantalla de configuracion de Claude Code esta soportada
por su manifiesto; su equivalente en el chat Desktop aun debe verificarse.

Elige la skill **trabajar** o escribe `/regent:trabajar` seguido de tu pedido, por
ejemplo: "En el dashboard de mi equipo, agrega un grafico mensual de registros".
Regent descubre el proyecto y sus reglas. Si falta informacion de negocio, la pide;
no necesitas nombres de tablas, SQL ni rutas locales.

Usar lenguaje natural sin elegir la skill tambien puede activarla, pero el modelo
puede seleccionar otro flujo. El plugin no garantiza esa seleccion automatica.
Un seguimiento relacionado conserva la conversacion y el trabajo del ejecutor.

## Estado de esta entrega

El manifiesto y el ZIP pasan la validacion de Claude Code. La distribucion al equipo
en el chat Desktop aun no esta validada: falta configurar el endpoint remoto, probar
su autenticacion en el cliente y verificar el flujo completo del plugin. Las pruebas
anteriores de Desktop usaron la skill independiente y el puente local, no este ZIP.

Un plugin con MCP remoto requiere una URL accesible desde Anthropic. Incluir un MCP
stdio local en el ZIP no lo habilita en el chat. En esta maquina siguen activos la
skill independiente y el puente local de prueba mientras se valida el reemplazo.
No se publico el servidor local ni se incluyeron tokens o rutas personales.

El administrador empaqueta con `pnpm plugin:pack` desde el repositorio de Regent.
El artefacto se genera en `tmp/regent-plugin.zip`. La configuracion de proyectos,
permisos y fuentes pertenece al servidor; la de implementacion pertenece a cada repo.
