---
updated: 2026-10-21
---

# Talently Code para Claude

Este plugin conecta Claude con el agente de codigo de Talently. Permite crear,
modificar, eliminar o investigar funcionalidades en webs, aplicaciones y dashboards.
Regent es el motor interno; las instrucciones y herramientas de cada proyecto
permanecen en su repositorio y las carga el ejecutor.

## Uso

En Claude Desktop, escribe `/talently-code` y elige la skill **talently-code**.
Tambien puedes pedir "Usa Talently Code y cambia la fecha del footer de la web de
Talently" o "Usa Talently Code y agrega un grafico mensual de registros al dashboard".
En clientes que requieren el nombre completo del plugin, usa
`/talently-code:talently-code`.

El agente resuelve el proyecto indicado por nombre, URL o repositorio antes de
editarlo. El repo predeterminado no reemplaza un destino explicito. Las consultas
y analisis aislados de datos pertenecen a Talently Data; las acciones de negocio
sin cambios de codigo pertenecen a sus integraciones operativas.

Elegir la skill carga el flujo explicitamente. La seleccion mediante texto libre
sigue dependiendo de Claude. El seguimiento usa las actividades del trabajo en
el mismo chat, sin crear tareas programadas para consultar su avance.

## Instalacion y cambio de nombre

Instala `talently-code-plugin.zip` en los plugins de Claude y configura el endpoint
y tu token personal en los campos privados del conector. No pegues el token en el
chat. El endpoint remoto debe ser accesible desde Anthropic para usarlo en el chat;
un servidor en localhost requiere el puente stdio para Claude Desktop.

El identificador cambia de `regent` a `talently-code`: el cliente puede tratarlo
como otro plugin. Verifica el nuevo y deshabilita el anterior para evitar entradas
duplicadas. El endpoint, tokens y conversaciones del servidor se conservan.
No edites las copias sincronizadas del plugin como mecanismo de actualizacion.

El nombre visible del servidor y del panel se configura con `name: Talently Code`
en la instancia MCP. El puente stdio conserva ese nombre. Las herramientas
`regent_context`, `regent_start`, `regent_get_run`, `regent_continue` y `regent_cancel`
siguen siendo compatibles con clientes anteriores.

## Distribucion

Ejecuta `pnpm plugin:pack` desde el repositorio de Regent. El artefacto se genera en
`tmp/talently-code-plugin.zip` con una lista explicita de cinco archivos: manifiesto,
configuracion MCP, skill, guia y licencia. No incluye tokens, entornos ni codigo
del servidor. El empaquetado y las pruebas de transporte no sustituyen verificar
la instalacion y el comando en el cliente Desktop.
