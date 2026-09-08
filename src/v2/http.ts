import http from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { Core } from './core.ts'

export function createHttp(core: Core, health: () => Record<string, unknown>, onGithub: () => void = () => {}, githubSecret = process.env.GITHUB_WEBHOOK_SECRET) {
  return http.createServer(async (request, response) => {
    const send = (code: number, value: unknown) => { response.writeHead(code, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
    try {
      if (request.method === 'GET' && request.url === '/healthz') return send(200, { ...health(), runs_running: core.active.size,
        queue_depth: core.store.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE state='queued'").get()!.n,
        deliveries_pending: core.store.db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE state='pending'").get()!.n,
        db_ok: core.store.db.prepare('SELECT 1 AS ok').get()!.ok === 1, auth_mode: core.config.auth.mode })
      if (request.method === 'GET' && request.url === '/metrics') {
        const rows = core.store.db.prepare('SELECT state,COUNT(*) AS n FROM runs GROUP BY state').all()
        response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
        return response.end(rows.map(row => `regent_runs{state="${row.state}"} ${row.n}`).join('\n') + '\n')
      }
      if (request.method === 'POST' && request.url === '/webhooks/github') {
        if (!githubSecret) return send(503, { error: 'Configura GITHUB_WEBHOOK_SECRET para habilitar este webhook.' })
        const chunks: Buffer[] = []; let size = 0
        for await (const chunk of request) {
          size += chunk.length
          if (size > 1024 * 1024) return send(413, { error: 'Evento mayor a 1 MB' })
          chunks.push(Buffer.from(chunk))
        }
        const raw = Buffer.concat(chunks)
        const expected = Buffer.from(`sha256=${createHmac('sha256', githubSecret).update(raw).digest('hex')}`)
        const actual = Buffer.from(String(request.headers['x-hub-signature-256'] ?? ''))
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return send(401, { error: 'Firma invalida' })
        const delivery = request.headers['x-github-delivery']
        if (typeof delivery !== 'string' || !delivery) return send(400, { error: 'Falta delivery id' })
        let event: any
        try { event = JSON.parse(raw.toString('utf8')) } catch { return send(400, { error: 'JSON invalido' }) }
        if (!event || typeof event !== 'object' || Array.isArray(event)) return send(400, { error: 'Evento invalido' })
        const accepted = core.store.db.prepare('INSERT OR IGNORE INTO inbound(adapter,event_id) VALUES(?,?)').run('github', delivery)
        if (accepted.changes && request.headers['x-github-event'] === 'pull_request' && event.action === 'closed' && event.pull_request?.merged === true) setImmediate(onGithub)
        return send(202, { accepted: true, duplicate: !accepted.changes })
      }
      if (!['/tools', '/hook-denial', '/tool-policy'].includes(request.url ?? '')) return send(404, { error: 'Ruta inexistente' })
      const token = request.headers.authorization?.replace(/^Bearer /, '') ?? ''
      const active = core.byToken(token)
      if (!active) return send(401, { error: 'Bearer de run invalido o vencido' })
      if (request.headers.origin) return send(403, { error: 'El MCP interno no acepta peticiones del navegador' })
      if (request.method !== 'POST') { response.setHeader('allow', 'POST'); return send(405, { error: 'Solo POST' }) }
      const chunks: Buffer[] = []; let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 1024 * 1024) return send(413, { error: 'Peticion mayor a 1 MB' })
        chunks.push(Buffer.from(chunk))
      }
      let payload: any
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return send(400, { error: 'JSON invalido' }) }
      if (request.url === '/tool-policy') {
        const input = z.object({ tool_name: z.string(), tool_input: z.record(z.string(), z.unknown()).optional() }).parse(payload)
        const reason = core.permission(token, input)
        if (reason) {
          core.store.event(active.run.id, 'permission_denied', { reason, tool: input.tool_name })
        }
        return send(200, { reason })
      }
      if (request.url === '/hook-denial') {
        const { reason } = z.object({ reason: z.string().max(4000) }).parse(payload)
        core.store.event(active.run.id, 'permission_denied', { reason })
        return send(200, { ok: true })
      }
      const server = new McpServer({ name: 'regent', version: '0.2.0' })
      const schemas = {
        regent_project_profiles: {},
        regent_create_project: { profile: z.string().min(1), destination: z.string().min(1), input: z.record(z.string(), z.string()).optional() },
        regent_use_repo: { repo: z.string().min(1), handoff: z.string().min(1).max(20000) },
        regent_status: { text: z.string().min(1).max(2000) },
        regent_ask_human: { question: z.string().min(1).max(3000), options: z.array(z.string().max(200)).max(5).optional() },
        regent_cancel: { reason: z.string().min(1).max(2000) },
        regent_worktree: { repo: z.string().min(1) },
        regent_run_tests: { repo: z.string().min(1) },
        regent_install: { repo: z.string().min(1) },
        regent_open_pr: { repo: z.string().min(1), title: z.string().min(1).max(200), body_md: z.string().min(1).max(50000), size_claim: z.enum(['S', 'M', 'L']).optional() },
        regent_close_pr: { repo: z.string().min(1) },
        regent_create_task: { title: z.string().min(1).max(200), summary_md: z.string().min(1).max(50000), plan_md: z.string().max(50000).optional(), size: z.enum(['S', 'M', 'L']), impact: z.enum(['low', 'medium', 'high']) },
        regent_update_task: { task_id: z.string().min(1), section: z.enum(['summary', 'plan', 'implementation', 'qa']), md: z.string().min(1).max(50000), questions: z.array(z.string().max(1000)).max(20).optional() },
        regent_request_qa: {},
      }
      for (const [name, inputSchema] of Object.entries(schemas)) {
        server.registerTool(name, { inputSchema }, async args => {
          try { return { content: [{ type: 'text' as const, text: JSON.stringify(await core.tool(token, name, args)) }] } }
          catch (error) { return { isError: true, content: [{ type: 'text' as const, text: (error as Error).message }] } }
        })
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      response.on('close', () => { void server.close().catch(() => {}) })
      await server.connect(transport)
      await transport.handleRequest(request, response, payload)
    } catch (error) {
      if (!response.headersSent) send(500, { error: (error as Error).message })
      else response.end()
    }
  })
}
