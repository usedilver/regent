---
updated: 2026-10-22
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

La version 0.3.2 requiere una instancia con OAuth configurado y accesible por HTTPS.
Instala el ZIP preparado por el administrador e inicia sesion cuando
Claude lo solicite. El endpoint ya esta incluido; no hay variables que completar.
Confirma la conexion desde la pantalla del servidor. No se pide
un token manual. El administrador configura el proveedor de identidad y los usuarios
autorizados en `config/regent.yaml`; instalar el plugin no concede acceso por si solo.

El endpoint remoto debe ser accesible desde Anthropic para usarlo en el chat. El
puente stdio existente sigue disponible para pruebas locales con token; esta version
del plugin HTTP no reemplaza ese puente ni convierte localhost en una URL publica.
No actualices una instalacion que depende de tokens hasta que su servidor tenga
OAuth operativo. El empaquetado no activa el proveedor ni despliega la instancia.

El identificador cambia de `regent` a `talently-code`: el cliente puede tratarlo
como otro plugin. Verifica el nuevo y deshabilita el anterior para evitar entradas
duplicadas. Las conversaciones se conservan en el servidor. Una conexion OAuth usa
una identidad verificada distinta del antiguo principal configurado con token;
los trabajos antiguos no se reasignan automaticamente.
No edites las copias sincronizadas del plugin como mecanismo de actualizacion.

El nombre visible del servidor y del panel se configura con `name: Talently Code`
en la instancia MCP. El puente stdio conserva ese nombre. Las herramientas
`regent_context`, `regent_start`, `regent_get_run`, `regent_continue` y `regent_cancel`
siguen siendo compatibles con clientes anteriores.

El seguimiento habitual es texto, sin tarjetas. `regent_get_run` espera hasta 20
segundos cuando el trabajo sigue activo y no adjunta una interfaz. El panel visual
se abre solo a pedido con `regent_show_progress`, una vez por conversacion; sus
actualizaciones no crean tarjetas nuevas ni repiten el informe final del agente.
Una consulta breve recibe una respuesta breve, sin convertirla en una auditoria.

## Distribucion

El administrador ejecuta desde el repositorio de Regent:

```bash
pnpm plugin:pack --endpoint https://your-regent-host.example/mcp
```

Sustituye el dominio del ejemplo por el servidor publicado con OAuth operativo.
El comando requiere una URL HTTPS literal y genera `.mcp.json` dentro del ZIP;
el directorio fuente contiene la skill y el manifiesto, no una conexion activa.
No depende de la sustitucion de `userConfig` en Desktop: la instalacion observada
mostro `${user_config.endpoint}` sin resolver en el modal del conector. La version
0.3.0 con ese marcador no debe distribuirse.

El artefacto se genera en
`dist/plugins/talently-code-<version>.zip` y su checksum `.zip.sha256`, con una lista explicita de cinco archivos: manifiesto,
configuracion MCP, skill, guia y licencia. No incluye tokens, entornos ni codigo
del servidor. El empaquetado y las pruebas de transporte no sustituyen verificar
la instalacion y el comando en el cliente Desktop.
