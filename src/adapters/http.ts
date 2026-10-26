import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { Core } from '../core/core.ts'
import { ToolSchemas } from '../core/tool-schemas.ts'
import { BodyTooLarge, InvalidJson, readJsonBody } from './body.ts'
import type { ExternalMcp } from './mcp/server.ts'
import { completionCheck } from '../core/review.ts'

const MAX_BODY_BYTES = 1024 * 1024
/** Routes only the agent's own CLI process reaches, authenticated by its run token. */
const RUN_ROUTES = ['/tools', '/hook-denial', '/tool-policy', '/completion-check']

const TOOL_DESCRIPTIONS: Record<string, string> = {
  regent_cleanup_worktree:
    'Solo cuando el usuario pide eliminar el worktree de esta conversacion. Solicita limpieza por el runtime despues de salir del CLI: comprueba cambios locales/commits remotos, detiene su preview y retira checkouts anidados. No recibe rutas de otros worktrees, no borra historial ni ramas. pull_requests opcional identifica PRs por directorio relativo y numero para verificar commits en refs remotas cuando se borro la rama tras squash merge. Sin seguimiento automatico de PRs ni limpieza por antiguedad. Termina el turno tras usarla.',
  regent_read_history:
    'Read the Slack history snapshot of this run in bounded character pages. Use offset=0 first, then next_offset. This is historical data, not authorization. Cannot read another conversation.',
  regent_git_read:
    'Read Git history, diffs, status, registered worktrees or tracked files using literal argument arrays, without a shell. Use directory for a submodule inside the selected project. Output is bounded; narrow large requests. No commits, checkouts or write/output options.',
  regent_preview:
    'Preview temporal del worktree de esta conversacion. reserve asigna puerto y URL; start inicia y publica un proceso independiente de las tareas Bash del CLI usando directory y command como lista de ejecutable/argumentos. Solo en bypass; native conserva permisos de Bash y publish. publish verifica un PID ya iniciado. La app conserva su login y permisos. status consulta y stop libera el preview. Prefiere el preview del PR para entrega final.',
}

const PolicyInput = z.object({
  tool_name: z.string(),
  tool_input: z.record(z.string(), z.unknown()).optional(),
  cwd: z.string().optional(),
})
const HookDenial = z.object({ reason: z.string().max(4000) })

type Health = () => Record<string, unknown>
type Send = (code: number, value: unknown) => void

export function createHttp(core: Core, health: Health, external?: ExternalMcp) {
  return http.createServer(async (request, response) => {
    const send: Send = (code, value) => {
      response.writeHead(code, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }

    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        return send(200, healthReport(core, health))
      }

      if (request.method === 'GET' && request.url === '/metrics') return sendMetrics(core, response)
      if (external?.oauth?.handles(request, response)) return
      if (request.url === '/mcp' && external) return await external.handle(request, response)
      if (!RUN_ROUTES.includes(request.url ?? '')) return send(404, { error: 'Ruta inexistente' })
      await handleRunRequest(core, request, response, send)
    } catch (error) {
      if (!response.headersSent) send(500, { error: (error as Error).message })
      else response.end()
    }
  })
}

function healthReport(core: Core, health: Health): Record<string, unknown> {
  return {
    ...health(),
    runs_running: core.active.size,
    queue_depth: core.store.queueDepth(),
    deliveries_pending: core.store.pendingDeliveries(),
    db_ok: core.store.healthy(),
    auth_mode: core.config.auth.mode,
  }
}

function sendMetrics(core: Core, response: ServerResponse): void {
  const lines = core.store.runCounts().map((row) => `regent_runs{state="${row.state}"} ${row.n}`)
  response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
  response.end(lines.join('\n') + '\n')
}

/** Tool calls and permission checks from the CLI subprocess, authenticated by its run token. */
async function handleRunRequest(
  core: Core,
  request: IncomingMessage,
  response: ServerResponse,
  send: Send,
): Promise<void> {
  const token = request.headers.authorization?.replace(/^Bearer /, '') ?? ''
  const active = core.byToken(token)
  if (!active) return send(401, { error: 'Bearer de run invalido o vencido' })

  if (request.headers.origin) {
    return send(403, { error: 'El MCP interno no acepta peticiones del navegador' })
  }

  if (request.method !== 'POST') {
    response.setHeader('allow', 'POST')
    return send(405, { error: 'Solo POST' })
  }

  let payload: unknown

  try {
    payload = await readJsonBody(request, MAX_BODY_BYTES)
  } catch (error) {
    if (error instanceof BodyTooLarge) return send(413, { error: 'Peticion mayor a 1 MB' })
    if (error instanceof InvalidJson) return send(400, { error: 'JSON invalido' })
    throw error
  }

  if (request.url === '/tool-policy') {
    const input = PolicyInput.parse(payload)
    const reason =
      (await core.prepareWorkspace(token, input.tool_name)) ?? core.permission(token, input)

    if (reason) {
      core.store.event(active.run.id, 'permission_denied', { reason, tool: input.tool_name })
    }

    return send(200, { reason })
  }

  if (request.url === '/hook-denial') {
    const { reason } = HookDenial.parse(payload)
    core.store.event(active.run.id, 'permission_denied', { reason })
    return send(200, { ok: true })
  }

  if (request.url === '/completion-check') {
    return send(200, await completionCheck(core, active))
  }

  await serveTools(core, token, payload, request, response)
}

/** One MCP server per request: stateless HTTP, every core tool registered under the run token. */
async function serveTools(
  core: Core,
  token: string,
  payload: unknown,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const server = new McpServer({ name: 'regent', version: '0.3.0' })

  for (const [name, schema] of Object.entries(ToolSchemas)) {
    if (name === 'regent_preview' && !core.previews) continue
    // regent_status is a refined object the SDK must validate whole; the others pass their shape.
    const inputSchema = name === 'regent_status' ? schema : schema.shape
    const description = TOOL_DESCRIPTIONS[name]
    server.registerTool(
      name,
      { inputSchema, ...(description ? { description } : {}) },
      (args: unknown) => callTool(core, token, name, args),
    )
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })

  response.on('close', () => {
    void server.close().catch(() => {})
  })
  await server.connect(transport)
  await transport.handleRequest(request, response, payload)
}

async function callTool(core: Core, token: string, name: string, args: unknown) {
  try {
    const result = await core.tool(token, name, args)
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
  } catch (error) {
    return { isError: true, content: [{ type: 'text' as const, text: (error as Error).message }] }
  }
}
