import { failureMessage, type ExecutionFailure } from '../../execution/failures.ts'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { z } from 'zod'
import type { Config } from '../../config.ts'
import type { Core } from '../../core/core.ts'
import { resolveRepository } from '../../core/repository.ts'
import { repositoryContext } from '../../core/repository-context.ts'
import type { Conversation, Inbound, Run } from '../../core/types.ts'
import { redact } from '../../storage/redact.ts'
import { bearerToken, BodyTooLarge, InvalidJson, readJsonBody } from '../body.ts'
import { mcpActivities } from './activities.ts'
import { OAuthServer } from './oauth.ts'
import { PROGRESS_URI, registerProgressResource } from './progress.ts'

const MAX_BODY_BYTES = 1024 * 1024
const MAX_RESULT_CHARS = 60000
const MIN_TOKEN_CHARS = 32
const ACTIVE_STATES = ['queued', 'running']

const text = z.string().trim().min(1).max(20000)
const requestId = z.string().uuid()
const conversationId = z.string().min(1).max(200)
const intent = z
  .enum(['ask', 'patch', 'task', 'project'])
  .describe(
    'ask: consulta de solo lectura; patch: cambio de codigo; task: ejecucion operativa, como levantar un preview; project: proyecto nuevo. Conserva las restricciones explicitas del usuario.',
  )
  .optional()
const digest = (value: string) => createHash('sha256').update(value).digest()

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}
const WRITE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
}

interface Principal {
  author: string
  tokenHash: Buffer
}

interface ToolSpec {
  name: string
  title: string
  description: string
  input: Record<string, z.ZodType>
  annotations: typeof READ
  /** Renders the progress panel instead of plain text. */
  ui?: boolean
  run(args: any, signal: AbortSignal): unknown
}

/** Static bearer principals from the environment, each with a unique id and token. */
function loadPrincipals(config: Config['mcp'], env: NodeJS.ProcessEnv): Principal[] {
  const ids = new Set<string>()
  const hashes = new Set<string>()

  return config.principals.map((principal) => {
    const token = env[principal.token_env]?.trim()

    if (!token || token.length < MIN_TOKEN_CHARS) {
      throw new Error(`Configura ${principal.token_env} con un token de al menos 32 caracteres.`)
    }

    const tokenHash = digest(token)

    if (ids.has(principal.id) || hashes.has(tokenHash.toString('hex'))) {
      throw new Error('Los principales y tokens MCP deben ser unicos.')
    }

    ids.add(principal.id)
    hashes.add(tokenHash.toString('hex'))
    return { author: `mcp:${principal.id}`, tokenHash }
  })
}

/** The public MCP endpoint: chat clients start, follow and continue work through it. */
export class ExternalMcp {
  core: Core
  principals: Principal[]
  oauth?: OAuthServer

  constructor(core: Core, env: NodeJS.ProcessEnv = process.env) {
    this.core = core
    const mcp = core.config.mcp

    if (!mcp.enabled || (!mcp.principals.length && !mcp.oauth)) {
      throw new Error('MCP requiere OAuth o al menos un principal configurado.')
    }

    if (mcp.oauth) {
      this.oauth = new OAuthServer(mcp.oauth, core.config.name, core.store, env, core.access)
      core.mcpIdentity = (author) => this.oauth!.tokens.identity(author)
    }

    this.principals = loadPrincipals(mcp, env)
  }

  defaultRepo(): string {
    return (
      path.relative(fs.realpathSync(this.core.cwd), fs.realpathSync(this.core.defaultCwd)) || '.'
    )
  }

  instructions(): string {
    const defaultRepo = this.defaultRepo()
    const name = this.core.config.name
    return `${name} ejecuta un agente de codigo con acceso a los repositorios del servidor, sus skills, instrucciones y fuentes configuradas. Para crear, modificar, eliminar o investigar codigo, webs, aplicaciones, vistas, dashboards o graficos de esos proyectos, usa ${name}. El repo predeterminado es ${JSON.stringify(defaultRepo)}. Llama regent_context cuando necesites descubrir el destino; si su resultado responde la pregunta, responde sin iniciar un trabajo. Para investigar o modificar el repo, delega el pedido a regent_start; repo es opcional y usa ese predeterminado. Cada conversación conserva su proyecto; para otro proyecto independiente inicia una nueva con regent_start y repo. Los servicios y submódulos del mismo proyecto comparten sesión. Conserva el proyecto o URL y el alcance del usuario: no conviertas preguntas breves en auditorias, checklists extensos ni informes de muchas secciones. Al delegar cambios visibles o de interaccion en una web, incluye un preview navegable como parte del resultado sin esperar que el usuario lo pida; respeta si lo rechaza. El ejecutor evalua el impacto real: consultas y cambios sin efecto visual o interactivo no requieren preview. Una edicion de frontend conserva su intent: patch; no la conviertas en otra consulta para pedir el preview despues. Para levantar un preview temporal usa intent: task, conservando el pedido original y los limites explicitos; ask es solo lectura y no puede iniciar servidores. No sustituyas ese pedido por una captura, no impongas mocks ni apagar el servidor al terminar salvo que el usuario lo solicite. Entrega preview.url cuando preview.ready sea true; ese campo indica el proceso actual de la conversacion, no certifica la revision ni que la ruta solicitada funcione. Si falta, comunica el bloqueo del ejecutor sin inventar un enlace. No deduzcas que falta acceso al repo o a sus datos porque esas herramientas no aparezcan en el chat: el agente las usa en el servidor. Presenta el servicio como ${name}; regent_* son nombres internos. Consulta regent_get_run con su espera predeterminada y continua con regent_continue. Si el turno falla o se interrumpe, comunica failure.message o error; result puede ser parcial y no demuestra que el trabajo terminó. El seguimiento normal es texto, sin paneles: para una consulta breve entrega solo el resultado, sin narrar cada consulta de estado. Solo si el usuario pide un panel visual, llama regent_show_progress una vez y deja que se actualice. No crees tareas programadas ni recordatorios. No afirmes acceso a datos ni cambios sin el resultado del agente. Las skills de otros plugins del chat no sustituyen las instrucciones del repo seleccionado.`
  }

  // Conversations

  conversation(author: string, key: string): Conversation {
    const conversation = this.core.store.conversation(key)

    if (!conversation || conversation.adapter !== 'mcp' || conversation.author !== author) {
      throw new Error('Conversacion inexistente o no autorizada.')
    }

    return conversation
  }

  status(author: string, runId: string) {
    const run = this.core.store.run(runId)
    if (!run) throw new Error('Run inexistente o no autorizado.')
    const conversation = this.conversation(author, run.conversation_key)
    const latest = this.core.store.latestRun(conversation.key)!
    const notice = this.core.store.lastEvent<{ text: string }>(latest.id, 'mcp_notice')
    const current = this.core.previews?.get(conversation.key)
    const preview = current ? this.core.previews!.result(current) : undefined

    return {
      conversation_id: conversation.key,
      conversation_state: conversation.state,
      repo: conversation.cwd,
      run: this.runSummary(run),
      latest_run: this.runSummary(latest),
      progress: notice?.text ?? null,
      activities: mcpActivities(this.core.store, latest),
      question: this.core.store.pendingQuestion(conversation.key) ?? null,
      preview_available: Boolean(this.core.previews),
      preview: preview
        ? {
            ready: preview.ready,
            url: preview.ready ? preview.url : null,
            expires_at: preview.expires_at,
          }
        : null,
    }
  }

  private runSummary(run: Run) {
    const failure = ['failed', 'interrupted'].includes(run.state)
      ? this.core.store.lastEvent<ExecutionFailure>(run.id, 'execution_failure')
      : undefined

    return {
      id: run.id,
      state: run.state,
      result: run.result?.slice(0, MAX_RESULT_CHARS) ?? null,
      result_truncated: (run.result?.length ?? 0) > MAX_RESULT_CHARS,
      error: run.error,
      cost_usd: run.cost,
      ...(failure ? { failure: publicFailure(failure) } : {}),
    }
  }

  /** The status once the latest run settles, or after `waitMs`, whichever comes first. */
  async waitStatus(author: string, runId: string, waitMs: number, signal?: AbortSignal) {
    const initial = this.status(author, runId)
    if (!ACTIVE_STATES.includes(initial.latest_run.state) || !waitMs) return initial
    const deadline = Date.now() + waitMs

    while (Date.now() < deadline) {
      await delay(Math.min(250, deadline - Date.now()), undefined, { signal })
      const latest = this.core.store.latestRun(initial.conversation_id)
      if (!latest || !ACTIVE_STATES.includes(latest.state)) break
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

  // Tools

  private tools(author: string): ToolSpec[] {
    const defaultRepo = this.defaultRepo()

    return [
      {
        name: 'regent_context',
        title: 'Explorar proyecto',
        description: `Repositorio predeterminado: ${defaultRepo}. Descubre sus instrucciones, skills, agentes y nombres de MCP declarados, o los de otro repo seleccionado. Usa esta herramienta antes de afirmar que el chat no tiene acceso al proyecto o sus datos. No ejecuta el modelo ni consulta datos de negocio.`,
        input: { repo: z.string().min(1).max(1000).optional() },
        annotations: READ,
        run: (args) => ({
          ...repositoryContext(this.core.cwd, args.repo ?? this.core.defaultCwd),
          default_repo: defaultRepo,
          next_step:
            'Si este contexto responde la pregunta, responde directamente. Para investigar o modificar el repo, envia el pedido a regent_start sin ampliar su alcance.',
        }),
      },
      {
        name: 'regent_start',
        title: 'Iniciar trabajo',
        description: `Repositorio predeterminado: ${defaultRepo}. Crea, modifica, elimina o investiga codigo, dashboards, vistas y graficos. Delega el pedido completo aunque el chat no tenga las herramientas de datos: el agente carga las skills y conexiones del repo. repo omitido usa ese predeterminado. Devuelve IDs inmediatamente; consulta regent_get_run. Usa un UUID nuevo como request_id y reutilizalo solo al reintentar la misma solicitud. Pide en prompt las pruebas, rama o PR que necesites.`,
        input: {
          request_id: requestId,
          repo: z.string().min(1).max(1000).optional(),
          prompt: text,
          intent,
        },
        annotations: WRITE,
        run: (args) => {
          const repo = resolveRepository(this.core.cwd, args.repo ?? this.core.defaultCwd)
          const key = `${author}:${args.request_id}`
          return this.submit(author, key, `start:${key}`, args.prompt, repo, args.intent)
        },
      },
      {
        name: 'regent_get_run',
        title: 'Consultar resultado',
        description:
          'Consulta el resultado sin crear un panel. Espera hasta 20 segundos por defecto si sigue activo; evita consultas repetidas sin espera y mensajes de progreso redundantes. latest_run incluye continuaciones automaticas. Cuando termine, responde una sola vez con el resultado proporcionado; no sigas consultando un trabajo terminado ni crees tareas programadas. Usa wait_ms: 0 solo para una consulta inmediata o desde el panel.',
        input: {
          run_id: z.string().uuid(),
          wait_ms: z.number().int().min(0).max(20000).default(20000),
        },
        annotations: READ,
        run: (args, signal) => this.waitStatus(author, args.run_id, args.wait_ms, signal),
      },
      {
        name: 'regent_show_progress',
        title: 'Abrir panel de progreso',
        description:
          'Abre un panel visual solo si el usuario lo solicita expresamente. Llama una sola vez por conversacion; el mismo panel consulta regent_get_run y se actualiza sin crear tarjetas adicionales. No lo uses para preguntas breves ni como paso habitual del seguimiento.',
        input: { run_id: z.string().uuid() },
        annotations: READ,
        ui: true,
        run: (args) => this.status(author, args.run_id),
      },
      {
        name: 'regent_continue',
        title: 'Continuar trabajo',
        description:
          'Continua una conversacion MCP propia, conservando sesion, repo y worktree. Tambien responde preguntas pendientes o reanuda trabajo interrumpido. Para levantar un preview usa intent: task y conserva el pedido del usuario; no lo reemplaces por capturas, mocks o apagar el servidor. Respeta limites explicitos de solo lectura. Usa request_id nuevo por mensaje y el mismo UUID para sus reintentos.',
        input: { conversation_id: conversationId, request_id: requestId, prompt: text, intent },
        annotations: WRITE,
        run: (args) => {
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
      },
      {
        name: 'regent_cancel',
        title: 'Detener trabajo',
        description:
          'Detiene el trabajo activo y pausa esta conversacion MCP. Conserva los mensajes en cola y los cambios de codigo. regent_continue puede reanudarla; no revierte archivos ni elimina ramas.',
        input: { conversation_id: conversationId },
        annotations: WRITE,
        run: async (args) => {
          this.conversation(author, args.conversation_id)
          await this.submit(
            author,
            args.conversation_id,
            `cancel:${author}:${randomUUID()}`,
            'stop',
          )
          return { conversation_id: args.conversation_id, paused: true, queued_preserved: true }
        },
      },
    ]
  }

  server(author: string): McpServer {
    const title = this.core.config.name
    const server = new McpServer(
      { name: 'regent', title, version: '0.3.2' },
      { instructions: this.instructions() },
    )

    registerProgressResource(server, title)
    for (const tool of this.tools(author)) this.register(server, author, title, tool)
    return server
  }

  private register(server: McpServer, author: string, title: string, tool: ToolSpec): void {
    const log = (outcome: 'ok' | 'error') =>
      console.log(JSON.stringify({ event: 'mcp_tool', author, tool: tool.name, outcome }))

    registerAppTool(
      server,
      tool.name,
      {
        title: `${title} · ${tool.title}`,
        description: tool.description,
        inputSchema: tool.input,
        annotations: tool.annotations,
        _meta: tool.ui ? { ui: { resourceUri: PROGRESS_URI } } : {},
      },
      async (args, extra) => {
        try {
          const result = await tool.run(args, extra.signal)
          log('ok')
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result as Record<string, unknown>,
          }
        } catch (error) {
          log('error')
          return {
            isError: true,
            content: [{ type: 'text' as const, text: redact((error as Error).message) }],
          }
        }
      },
    )
  }

  // Transport

  /** The author behind a bearer token: a static principal, or an OAuth session. */
  private async authenticate(token: string): Promise<string | undefined> {
    const candidate = digest(token)
    const principal = this.principals.find((value) => timingSafeEqual(candidate, value.tokenHash))
    if (principal) return principal.author
    if (!this.oauth) return undefined

    try {
      const info = await this.oauth.verifyAccessToken(token)
      return info.extra.author
    } catch {
      return undefined
    }
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const send = (code: number, error: string) => {
      response.writeHead(code, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error }))
    }

    const author = await this.authenticate(bearerToken(request))

    if (!author) {
      response.setHeader('www-authenticate', this.oauth?.challenge() ?? 'Bearer')
      return send(401, 'Bearer MCP invalido.')
    }

    if (request.headers.origin) return send(403, 'El endpoint MCP no acepta peticiones con Origin.')

    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST')
      return send(405, 'Solo POST.')
    }

    let payload: unknown

    try {
      payload = await readJsonBody(request, MAX_BODY_BYTES)
    } catch (error) {
      if (error instanceof BodyTooLarge) return send(413, 'Peticion mayor a 1 MB.')
      if (error instanceof InvalidJson) return send(400, 'JSON invalido.')
      throw error
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

/** The failure fields a chat client may show; internal detail stays in the event log. */
function publicFailure(failure: ExecutionFailure) {
  return {
    source: failure.source,
    code: failure.code,
    message: failureMessage(failure),
    ...(failure.reset ? { reset: failure.reset } : {}),
    ...(failure.fresh_session !== undefined ? { fresh_session: failure.fresh_session } : {}),
  }
}
