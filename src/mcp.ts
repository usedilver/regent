import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { Core } from './core.ts'
import { resolveRepository } from './repository.ts'
import { redact } from './store.ts'
import type { Conversation, Inbound, Run } from './types.ts'
import { repositoryContext } from './repository-context.ts'
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { mcpActivities } from './mcp-activities.ts'
import { PROGRESS_URI, registerProgressResource } from './mcp-progress.ts'

const MAX_BODY_BYTES = 1024 * 1024
const MAX_RESULT_CHARS = 60000
const text = z.string().trim().min(1).max(20000)
const requestId = z.string().uuid()
const conversationId = z.string().min(1).max(200)
const intent = z.enum(['ask', 'patch', 'task', 'project']).optional()
const digest = (value: string) => createHash('sha256').update(value).digest()

export class ExternalMcp {
  core: Core
  principals: Array<{ author: string; tokenHash: Buffer }>
  constructor(core: Core, env: NodeJS.ProcessEnv = process.env) {
    this.core = core
    if (!core.config.mcp.enabled || !core.config.mcp.principals.length) throw new Error('MCP requiere al menos un principal configurado.')
    const ids = new Set<string>(), hashes = new Set<string>()
    this.principals = core.config.mcp.principals.map(principal => {
      const token = env[principal.token_env]?.trim()
      if (!token || token.length < 32) throw new Error(`Configura ${principal.token_env} con un token de al menos 32 caracteres.`)
      const tokenHash = digest(token)
      if (ids.has(principal.id) || hashes.has(tokenHash.toString('hex'))) throw new Error('Los principales y tokens MCP deben ser unicos.')
      ids.add(principal.id); hashes.add(tokenHash.toString('hex'))
      return { author: `mcp:${principal.id}`, tokenHash }
    })
  }
  defaultRepo(): string {
    return path.relative(fs.realpathSync(this.core.cwd), fs.realpathSync(this.core.defaultCwd)) || '.'
  }
  instructions(): string {
    const defaultRepo = this.defaultRepo()
    return `Regent ejecuta un agente de codigo con acceso a los repositorios del servidor, sus skills, instrucciones y fuentes configuradas. Para crear, modificar, eliminar o investigar codigo, vistas, dashboards o graficos de esos proyectos, usa Regent. El repo predeterminado es ${JSON.stringify(defaultRepo)}. Llama regent_context para conocerlo y regent_start para delegar el pedido completo; repo es opcional y usa ese predeterminado. No deduzcas que falta acceso al repo o a sus datos porque esas herramientas no aparezcan en el chat: el agente las usa en el servidor. Primero compruebalo con Regent. Muestra el panel con regent_get_run para seguir las actividades en esta conversacion y continua con regent_continue. No crees tareas programadas ni recordatorios para hacer seguimiento; si no hay panel, consulta el estado dentro del mismo turno. No afirmes acceso a datos ni cambios realizados sin el resultado del agente. Las skills de otros plugins del chat no sustituyen las instrucciones del repo seleccionado.`
  }
  conversation(author: string, key: string): Conversation {
    const conversation = this.core.store.conversation(key)
    if (!conversation || conversation.adapter !== 'mcp' || conversation.author !== author) throw new Error('Conversacion inexistente o no autorizada.')
    return conversation
  }
  status(author: string, runId: string) {
    const run = this.core.store.run(runId)
    if (!run) throw new Error('Run inexistente o no autorizado.')
    const conversation = this.conversation(author, run.conversation_key)
    const latest = this.core.store.db.prepare('SELECT * FROM runs WHERE conversation_key=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(conversation.key) as unknown as Run
    const question = this.core.store.db.prepare("SELECT question,options FROM gates WHERE conversation_key=? AND state='pending'").get(conversation.key)
    const notice = this.core.store.db.prepare("SELECT data FROM events WHERE run_id=? AND kind='mcp_notice' ORDER BY id DESC LIMIT 1").get(latest.id)
    const summary = (value: Run) => ({
      id: value.id, state: value.state, result: value.result?.slice(0, MAX_RESULT_CHARS) ?? null,
      result_truncated: (value.result?.length ?? 0) > MAX_RESULT_CHARS, error: value.error, cost_usd: value.cost,
    })
    return {
      conversation_id: conversation.key, conversation_state: conversation.state,
      repo: conversation.cwd, run: summary(run), latest_run: summary(latest),
      progress: notice ? JSON.parse(notice.data as string).text : null,
      activities: mcpActivities(this.core.store, latest),
      question: question ? { text: question.question, options: JSON.parse(question.options as string) } : null,
    }
  }
  async submit(author: string, key: string, eventId: string, prompt: string, repo?: string, profile?: Inbound['intent']) {
    const accepted = await this.core.submit({ adapter: 'mcp', eventId, key, author, text: prompt, repo, channel: key, intent: profile })
    return { conversation_id: key, run_id: accepted.runId, duplicate: accepted.duplicate, command: accepted.command }
  }
  server(author: string): McpServer {
    const server = new McpServer({ name: 'regent', version: '0.3.0' }, { instructions: this.instructions() })
    registerProgressResource(server)
    const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    const write = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
    const register = (name: string, description: string, inputSchema: Record<string, z.ZodType>, annotations: typeof read, action: (args: any) => unknown) => {
      const ui = ['regent_start', 'regent_continue', 'regent_get_run'].includes(name)
      registerAppTool(server, name, { description, inputSchema, annotations,
        _meta: ui ? { ui: { resourceUri: PROGRESS_URI } } : {} }, async args => {
        try {
          const result = await action(args)
          console.log(JSON.stringify({ event: 'mcp_tool', author, tool: name, outcome: 'ok' }))
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> }
        }
        catch (error) {
          console.log(JSON.stringify({ event: 'mcp_tool', author, tool: name, outcome: 'error' }))
          return { isError: true, content: [{ type: 'text' as const, text: redact((error as Error).message) }] }
        }
      })
    }
    register('regent_context', `Repositorio predeterminado: ${this.defaultRepo()}. Descubre sus instrucciones, skills, agentes y nombres de MCP declarados, o los de otro repo seleccionado. Usa esta herramienta antes de afirmar que el chat no tiene acceso al proyecto o sus datos. No ejecuta el modelo ni consulta datos de negocio.`,
      { repo: z.string().min(1).max(1000).optional() }, read, args => ({
        ...repositoryContext(this.core.cwd, args.repo ?? this.core.defaultCwd),
        default_repo: this.defaultRepo(),
        next_step: 'Envia el pedido completo a regent_start. No necesitas copiar las skills al chat ni conocer los nombres de tablas.',
      }))
    register('regent_start', `Repositorio predeterminado: ${this.defaultRepo()}. Crea, modifica, elimina o investiga codigo, dashboards, vistas y graficos. Delega el pedido completo aunque el chat no tenga las herramientas de datos: el agente carga las skills y conexiones del repo. repo omitido usa ese predeterminado. Devuelve IDs inmediatamente; consulta regent_get_run. Usa un UUID nuevo como request_id y reutilizalo solo al reintentar la misma solicitud. Pide en prompt las pruebas, rama o PR que necesites.`,
      { request_id: requestId, repo: z.string().min(1).max(1000).optional(), prompt: text, intent }, write, async args => {
        const repo = resolveRepository(this.core.cwd, args.repo ?? this.core.defaultCwd)
        const key = `${author}:${args.request_id}`
        return this.submit(author, key, `start:${key}`, args.prompt, repo, args.intent)
      })
    register('regent_get_run', 'Muestra el panel de progreso con actividades reales y checks en esta conversacion. El panel se actualiza sin tareas programadas. latest_run incluye continuaciones automaticas. Si el cliente no muestra panel, consulta esta herramienta en el mismo turno hasta terminar o esperar una respuesta humana; no crees recordatorios para hacer polling.',
      { run_id: z.string().uuid() }, read, args => this.status(author, args.run_id))
    register('regent_continue', 'Continua una conversacion MCP propia, conservando sesion, repo y worktree. Tambien responde preguntas pendientes o reanuda trabajo interrumpido. Usa request_id nuevo por mensaje y el mismo UUID para sus reintentos.',
      { conversation_id: conversationId, request_id: requestId, prompt: text, intent }, write, async args => {
        const conversation = this.conversation(author, args.conversation_id)
        resolveRepository(this.core.cwd, conversation.cwd)
        return this.submit(author, conversation.key, `continue:${conversation.key}:${args.request_id}`, args.prompt, undefined, args.intent)
      })
    register('regent_cancel', 'Detiene el trabajo activo y pausa esta conversacion MCP. Conserva los mensajes en cola y los cambios de codigo. regent_continue puede reanudarla; no revierte archivos ni elimina ramas.',
      { conversation_id: conversationId }, write, async args => {
        this.conversation(author, args.conversation_id)
        await this.submit(author, args.conversation_id, `cancel:${author}:${randomUUID()}`, 'stop')
        return { conversation_id: args.conversation_id, paused: true, queued_preserved: true }
      })
    return server
  }
  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const send = (code: number, error: string) => { response.writeHead(code, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error })) }
    const authorization = request.headers.authorization ?? ''
    const candidate = digest(/^Bearer /i.test(authorization) ? authorization.slice(7).trim() : '')
    const principal = this.principals.find(value => timingSafeEqual(candidate, value.tokenHash))
    if (!principal) { response.setHeader('www-authenticate', 'Bearer'); return send(401, 'Bearer MCP invalido.') }
    if (request.headers.origin) return send(403, 'El endpoint MCP no acepta peticiones con Origin.')
    if (request.method !== 'POST') { response.setHeader('allow', 'POST'); return send(405, 'Solo POST.') }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) return send(413, 'Peticion mayor a 1 MB.')
      chunks.push(Buffer.from(chunk))
    }
    let payload: unknown
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { return send(400, 'JSON invalido.') }
    const server = this.server(principal.author)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    response.on('close', () => { void server.close().catch(() => {}) })
    await server.connect(transport)
    await transport.handleRequest(request, response, payload)
  }
}
