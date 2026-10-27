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
    'ask: read-only investigation; patch: code changes; task: runtime operations; project: a new project. Preserve explicit user restrictions.',
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
    return `${name} runs Claude Code with the selected project's instructions, skills and connections. Use it to investigate, change code or operate that project, including application review. The default repository is ${JSON.stringify(defaultRepo)}. regent_context discovers a destination; its inventory does not prove functionality or copy project skills into this chat. Preserve the original request, URL, scope and restrictions when delegating. Each conversation retains its project; start a new one with repo for an independent project. Projects own development, validation, previews and collaboration; the engine imposes no business workflow. Use intent: ask for read-only investigation or existing-link discovery. Follow project guidance to find the native hosting preview; requesting a link does not require a server. Use intent: task for runtime operations while preserving source-change limits. Do not replace a request with mocked screenshots or an unauthorized deployment. Missing host-chat connectors do not prove missing executor access. Poll regent_get_run with its default wait and continue with regent_continue. Report results and limitations in proportion to the request and in the user's language. Use the project hosting provider for deployment previews. A successful build or login redirect does not verify an authenticated application. Regent does not host or proxy application previews. On failure report failure.message or error and distinguish partial results. Normal follow-up is text; use regent_show_progress only when a visual panel is requested. Do not create reminders or scheduled tasks. Claim actions only with evidence; presentation guidance never changes permissions.`
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
    return {
      conversation_id: conversation.key,
      conversation_state: conversation.state,
      repo: conversation.cwd,
      run: this.runSummary(run),
      latest_run: this.runSummary(latest),
      progress: notice?.text ?? null,
      activities: mcpActivities(this.core.store, latest),
      question: this.core.store.pendingQuestion(conversation.key) ?? null,
    }
  }

  private runSummary(run: Run) {
    const cleanup = this.core.store.lastEvent(run.id, 'worktree_cleanup')
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
      ...(cleanup ? { cleanup } : {}),
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
        title: 'Explore project',
        description: `Default repository: ${defaultRepo}. Discover its declared instructions, skills, agents and MCP names, or those of another selected repository. Use this before claiming the chat lacks project/data access. Does not run the model or query business data.`,
        input: { repo: z.string().min(1).max(1000).optional() },
        annotations: READ,
        run: (args) => ({
          ...repositoryContext(this.core.cwd, args.repo ?? this.core.defaultCwd),
          default_repo: defaultRepo,
          next_step:
            'If this context answers the question, reply directly. Otherwise delegate repository investigation or changes through regent_start without expanding scope.',
        }),
      },
      {
        name: 'regent_start',
        title: 'Start work',
        description: `Default repository: ${defaultRepo}. Create, change, remove or investigate code, dashboards, views and charts. Delegate the full request even when host-chat data tools are absent: the executor loads repository skills/connections. Omitting repo uses the default. Returns IDs immediately; follow with regent_get_run. Use a fresh request_id UUID, reusing it only to retry the same submission. Preserve requested checks, branch and PR scope in prompt.`,
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
        title: 'Get result',
        description:
          'Read results without creating a panel. Waits up to 20 seconds by default while active; avoid immediate repeated polls and redundant progress. latest_run includes automatic continuations. Preserve reported limitations. Deployment availability does not prove the requested application works; preserve the executor’s verification limits. Reply once with the supplied result, stop polling completed work and do not create scheduled tasks. Use wait_ms: 0 only for an immediate query or the panel.',
        input: {
          run_id: z.string().uuid(),
          wait_ms: z.number().int().min(0).max(20000).default(20000),
        },
        annotations: READ,
        run: (args, signal) => this.waitStatus(author, args.run_id, args.wait_ms, signal),
      },
      {
        name: 'regent_show_progress',
        title: 'Open progress panel',
        description:
          'Open a visual panel only when explicitly requested, once per conversation. The same panel polls regent_get_run and updates without extra cards. Do not use it for brief questions or normal text follow-up.',
        input: { run_id: z.string().uuid() },
        annotations: READ,
        ui: true,
        run: (args) => this.status(author, args.run_id),
      },
      {
        name: 'regent_continue',
        title: 'Continue work',
        description:
          'Continue an owned MCP conversation, preserving session, repository and worktree. Also answer pending questions or resume interrupted work. Runtime startup needs intent: task; preserve the request rather than substituting screenshots, mocks or immediate shutdown. Honor explicit read-only limits. Use a new request_id per human message and retain it for retries.',
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
        title: 'Stop work',
        description:
          'Stop active work and pause this MCP conversation while preserving queued messages and code changes. regent_continue can resume it; files and branches are not reverted or removed.',
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
      { name: 'regent', title, version: '0.4.1' },
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
