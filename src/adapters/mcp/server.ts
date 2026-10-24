import { failureMessage, type ExecutionFailure } from '../../execution/failures.ts'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { Core } from '../../core/core.ts'
import { resolveRepository } from '../../core/repository.ts'
import { redact } from '../../storage/redact.ts'
import type { Conversation, Inbound, Run } from '../../core/types.ts'
import { repositoryContext } from '../../core/repository-context.ts'
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { mcpActivities } from './activities.ts'
import { PROGRESS_URI, registerProgressResource } from './progress.ts'
import { OAuthServer } from './oauth.ts'

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
  oauth?: OAuthServer
  constructor(core: Core, env: NodeJS.ProcessEnv = process.env) {
    this.core = core
    if (!core.config.mcp.enabled || (!core.config.mcp.principals.length && !core.config.mcp.oauth))
      throw new Error('MCP requiere OAuth o al menos un principal configurado.')
    if (core.config.mcp.oauth) {
      this.oauth = new OAuthServer(
        core.config.mcp.oauth,
        core.config.name,
        core.store,
        env,
        core.access,
      )
      core.mcpIdentity = (author) => this.oauth!.tokens.identity(author)
    }
    const ids = new Set<string>(),
      hashes = new Set<string>()
    this.principals = core.config.mcp.principals.map((principal) => {
      const token = env[principal.token_env]?.trim()
      if (!token || token.length < 32)
        throw new Error(`Configura ${principal.token_env} con un token de al menos 32 caracteres.`)
      const tokenHash = digest(token)
      if (ids.has(principal.id) || hashes.has(tokenHash.toString('hex')))
        throw new Error('Los principales y tokens MCP deben ser unicos.')
      ids.add(principal.id)
      hashes.add(tokenHash.toString('hex'))
      return { author: `mcp:${principal.id}`, tokenHash }
    })
  }
  defaultRepo(): string {
    return (
      path.relative(fs.realpathSync(this.core.cwd), fs.realpathSync(this.core.defaultCwd)) || '.'
    )
  }
  instructions(): string {
    const defaultRepo = this.defaultRepo()
    const name = this.core.config.name
    return `${name} ejecuta un agente de codigo con acceso a los repositorios del servidor, sus skills, instrucciones y fuentes configuradas. Para crear, modificar, eliminar o investigar codigo, webs, aplicaciones, vistas, dashboards o graficos de esos proyectos, usa ${name}. El repo predeterminado es ${JSON.stringify(defaultRepo)}. Llama regent_context cuando necesites descubrir el destino; si su resultado responde la pregunta, responde sin iniciar un trabajo. Para investigar o modificar el repo, delega el pedido a regent_start; repo es opcional y usa ese predeterminado. Cada conversación conserva su proyecto; para otro proyecto independiente inicia una nueva con regent_start y repo. Los servicios y submódulos del mismo proyecto comparten sesión. Conserva el proyecto o URL y el alcance del usuario: no conviertas preguntas breves en auditorias, checklists extensos ni informes de muchas secciones. No deduzcas que falta acceso al repo o a sus datos porque esas herramientas no aparezcan en el chat: el agente las usa en el servidor. Presenta el servicio como ${name}; regent_* son nombres internos. Consulta regent_get_run con su espera predeterminada y continua con regent_continue. El seguimiento normal es texto, sin paneles: para una consulta breve entrega solo el resultado, sin narrar cada consulta de estado. Solo si el usuario pide un panel visual, llama regent_show_progress una vez y deja que se actualice. No crees tareas programadas ni recordatorios. No afirmes acceso a datos ni cambios sin el resultado del agente. Las skills de otros plugins del chat no sustituyen las instrucciones del repo seleccionado.`
  }
  conversation(author: string, key: string): Conversation {
    const conversation = this.core.store.conversation(key)
    if (!conversation || conversation.adapter !== 'mcp' || conversation.author !== author)
      throw new Error('Conversacion inexistente o no autorizada.')
    return conversation
  }
  status(author: string, runId: string) {
    const run = this.core.store.run(runId)
    if (!run) throw new Error('Run inexistente o no autorizado.')
    const conversation = this.conversation(author, run.conversation_key)
    const latest = this.core.store.db
      .prepare(
        'SELECT * FROM runs WHERE conversation_key=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
      )
      .get(conversation.key) as unknown as Run
    const question = this.core.store.db
      .prepare("SELECT question,options FROM gates WHERE conversation_key=? AND state='pending'")
      .get(conversation.key)
    const notice = this.core.store.db
      .prepare(
        "SELECT data FROM events WHERE run_id=? AND kind='mcp_notice' ORDER BY id DESC LIMIT 1",
      )
      .get(latest.id)
    const summary = (value: Run) => {
      const event =
        value.state === 'failed'
          ? this.core.store.db
              .prepare(
                "SELECT data FROM events WHERE run_id=? AND kind='execution_failure' ORDER BY id DESC LIMIT 1",
              )
              .get(value.id)
          : undefined
      const failure: ExecutionFailure | undefined = event
        ? JSON.parse(event.data as string)
        : undefined
      return {
        id: value.id,
        state: value.state,
        result: value.result?.slice(0, MAX_RESULT_CHARS) ?? null,
        result_truncated: (value.result?.length ?? 0) > MAX_RESULT_CHARS,
        error: value.error,
        cost_usd: value.cost,
        ...(failure
          ? {
              failure: {
                source: failure.source,
                code: failure.code,
                message: failureMessage(failure),
                ...(failure.reset ? { reset: failure.reset } : {}),
                ...(failure.fresh_session !== undefined
                  ? { fresh_session: failure.fresh_session }
                  : {}),
              },
            }
          : {}),
      }
    }
    return {
      conversation_id: conversation.key,
      conversation_state: conversation.state,
      repo: conversation.cwd,
      run: summary(run),
      latest_run: summary(latest),
      progress: notice ? JSON.parse(notice.data as string).text : null,
      activities: mcpActivities(this.core.store, latest),
      question: question
        ? { text: question.question, options: JSON.parse(question.options as string) }
        : null,
    }
  }
  async waitStatus(author: string, runId: string, waitMs: number, signal?: AbortSignal) {
    const initial = this.status(author, runId)
    if (!['queued', 'running'].includes(initial.latest_run.state) || !waitMs) return initial
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      await delay(Math.min(250, deadline - Date.now()), undefined, { signal })
      const latest = this.core.store.db
        .prepare(
          'SELECT state FROM runs WHERE conversation_key=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
        )
        .get(initial.conversation_id)
      if (!latest || !['queued', 'running'].includes(latest.state as string)) break
    }
    return this.status(author, runId)
  }
  async submit(
    author: string,
    key: string,
    eventId: string,
    prompt: string,
    repo?: string,
    profile?: Inbound['intent'],
  ) {
    const accepted = await this.core.submit({
      adapter: 'mcp',
      eventId,
      key,
      author,
      text: prompt,
      repo,
      channel: key,
      intent: profile,
    })
    return {
      conversation_id: key,
      run_id: accepted.runId,
      duplicate: accepted.duplicate,
      command: accepted.command,
    }
  }
  server(author: string): McpServer {
    const title = this.core.config.name
    const server = new McpServer(
      { name: 'regent', title, version: '0.3.0' },
      { instructions: this.instructions() },
    )
    registerProgressResource(server, title)
    const titles: Record<string, string> = {
      regent_context: 'Explorar proyecto',
      regent_start: 'Iniciar trabajo',
      regent_get_run: 'Consultar resultado',
      regent_show_progress: 'Abrir panel de progreso',
      regent_continue: 'Continuar trabajo',
      regent_cancel: 'Detener trabajo',
    }
    const read = {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }
    const write = {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    }
    const register = (
      name: string,
      description: string,
      inputSchema: Record<string, z.ZodType>,
      annotations: typeof read,
      action: (args: any, signal: AbortSignal) => unknown,
    ) => {
      const ui = name === 'regent_show_progress'
      registerAppTool(
        server,
        name,
        {
          title: `${title} · ${titles[name]}`,
          description,
          inputSchema,
          annotations,
          _meta: ui ? { ui: { resourceUri: PROGRESS_URI } } : {},
        },
        async (args, extra) => {
          try {
            const result = await action(args, extra.signal)
            console.log(JSON.stringify({ event: 'mcp_tool', author, tool: name, outcome: 'ok' }))
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result) }],
              structuredContent: result as Record<string, unknown>,
            }
          } catch (error) {
            console.log(JSON.stringify({ event: 'mcp_tool', author, tool: name, outcome: 'error' }))
            return {
              isError: true,
              content: [{ type: 'text' as const, text: redact((error as Error).message) }],
            }
          }
        },
      )
    }
    register(
      'regent_context',
      `Repositorio predeterminado: ${this.defaultRepo()}. Descubre sus instrucciones, skills, agentes y nombres de MCP declarados, o los de otro repo seleccionado. Usa esta herramienta antes de afirmar que el chat no tiene acceso al proyecto o sus datos. No ejecuta el modelo ni consulta datos de negocio.`,
      { repo: z.string().min(1).max(1000).optional() },
      read,
      (args) => ({
        ...repositoryContext(this.core.cwd, args.repo ?? this.core.defaultCwd),
        default_repo: this.defaultRepo(),
        next_step:
          'Si este contexto responde la pregunta, responde directamente. Para investigar o modificar el repo, envia el pedido a regent_start sin ampliar su alcance.',
      }),
    )
    register(
      'regent_start',
      `Repositorio predeterminado: ${this.defaultRepo()}. Crea, modifica, elimina o investiga codigo, dashboards, vistas y graficos. Delega el pedido completo aunque el chat no tenga las herramientas de datos: el agente carga las skills y conexiones del repo. repo omitido usa ese predeterminado. Devuelve IDs inmediatamente; consulta regent_get_run. Usa un UUID nuevo como request_id y reutilizalo solo al reintentar la misma solicitud. Pide en prompt las pruebas, rama o PR que necesites.`,
      { request_id: requestId, repo: z.string().min(1).max(1000).optional(), prompt: text, intent },
      write,
      async (args) => {
        const repo = resolveRepository(this.core.cwd, args.repo ?? this.core.defaultCwd)
        const key = `${author}:${args.request_id}`
        return this.submit(author, key, `start:${key}`, args.prompt, repo, args.intent)
      },
    )
    register(
      'regent_get_run',
      'Consulta el resultado sin crear un panel. Espera hasta 20 segundos por defecto si sigue activo; evita consultas repetidas sin espera y mensajes de progreso redundantes. latest_run incluye continuaciones automaticas. Cuando termine, responde una sola vez con el resultado proporcionado; no sigas consultando un trabajo terminado ni crees tareas programadas. Usa wait_ms: 0 solo para una consulta inmediata o desde el panel.',
      { run_id: z.string().uuid(), wait_ms: z.number().int().min(0).max(20000).default(20000) },
      read,
      (args, signal) => this.waitStatus(author, args.run_id, args.wait_ms, signal),
    )
    register(
      'regent_show_progress',
      'Abre un panel visual solo si el usuario lo solicita expresamente. Llama una sola vez por conversacion; el mismo panel consulta regent_get_run y se actualiza sin crear tarjetas adicionales. No lo uses para preguntas breves ni como paso habitual del seguimiento.',
      { run_id: z.string().uuid() },
      read,
      (args) => this.status(author, args.run_id),
    )
    register(
      'regent_continue',
      'Continua una conversacion MCP propia, conservando sesion, repo y worktree. Tambien responde preguntas pendientes o reanuda trabajo interrumpido. Usa request_id nuevo por mensaje y el mismo UUID para sus reintentos.',
      { conversation_id: conversationId, request_id: requestId, prompt: text, intent },
      write,
      async (args) => {
        const conversation = this.conversation(author, args.conversation_id)
        resolveRepository(this.core.cwd, conversation.cwd)
        return this.submit(
          author,
          conversation.key,
          `continue:${conversation.key}:${args.request_id}`,
          args.prompt,
          undefined,
          args.intent,
        )
      },
    )
    register(
      'regent_cancel',
      'Detiene el trabajo activo y pausa esta conversacion MCP. Conserva los mensajes en cola y los cambios de codigo. regent_continue puede reanudarla; no revierte archivos ni elimina ramas.',
      { conversation_id: conversationId },
      write,
      async (args) => {
        this.conversation(author, args.conversation_id)
        await this.submit(author, args.conversation_id, `cancel:${author}:${randomUUID()}`, 'stop')
        return { conversation_id: args.conversation_id, paused: true, queued_preserved: true }
      },
    )
    return server
  }
  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const send = (code: number, error: string) => {
      response.writeHead(code, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error }))
    }
    const authorization = request.headers.authorization ?? ''
    const candidate = digest(/^Bearer /i.test(authorization) ? authorization.slice(7).trim() : '')
    const principal = this.principals.find((value) => timingSafeEqual(candidate, value.tokenHash))
    let author = principal?.author
    if (!author && this.oauth) {
      try {
        const info = await this.oauth.verifyAccessToken(
          /^Bearer /i.test(authorization) ? authorization.slice(7).trim() : '',
        )
        author = info.extra.author
      } catch {}
    }
    if (!author) {
      response.setHeader('www-authenticate', this.oauth?.challenge() ?? 'Bearer')
      return send(401, 'Bearer MCP invalido.')
    }
    if (request.headers.origin) return send(403, 'El endpoint MCP no acepta peticiones con Origin.')
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST')
      return send(405, 'Solo POST.')
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) return send(413, 'Peticion mayor a 1 MB.')
      chunks.push(Buffer.from(chunk))
    }
    let payload: unknown
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return send(400, 'JSON invalido.')
    }
    const server = this.server(author)
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
}
