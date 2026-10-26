import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import path from 'node:path'
import { REGENT_DIR } from '../env.ts'
import { ensureTrusted, ensureBypassAccepted } from './claude-settings.ts'
import type { ImageInput } from '../core/images.ts'
import { createSystemPrompt } from './prompt.ts'
import { executionFailure, type ExecutionFailure } from './failures.ts'

type ToolEvent = { id: string; parentId?: string | null }
type McpConnection = { name: string; status?: string }

export type RunnerEvent =
  | {
      kind: 'init'
      sessionId: string
      mcpServers: McpConnection[]
      errors: unknown
      cwd: string | null
      skills: string[]
      agents: string[]
      tools: string[]
    }
  | { kind: 'api_retry'; attempt: number; error: unknown }
  | { kind: 'text_delta'; text: string }
  | ({ kind: 'tool_use'; name: string; input?: Record<string, unknown> } & ToolEvent)
  | ({ kind: 'tool_result'; background?: boolean; error?: boolean; content?: unknown } & ToolEvent)
  | {
      kind: 'result'
      text: string
      cost: number
      usage: unknown
      error: boolean
      errors: string[]
      denials: unknown[]
      subtype?: string
    }
  | { kind: 'mcp_degraded'; servers: string[] }

type InitEvent = Extract<RunnerEvent, { kind: 'init' }>
type ResultEvent = Extract<RunnerEvent, { kind: 'result' }>

export interface RunnerResult {
  state: 'completed' | 'failed' | 'interrupted'
  text: string
  error: string
  cost: number
  usage: unknown
  failure?: ExecutionFailure
}

export interface RunnerHandle {
  done: Promise<RunnerResult>
  cancel(reason?: string): void
  setTimeoutMs?(ms: number): void
}

export interface RunnerOptions {
  cwd: string
  prompt: string
  runId: string
  sessionId?: string | null
  model?: string | null
  images?: ImageInput[]
  env?: NodeJS.ProcessEnv
  toolsUrl: string
  token: string
  readonlyMcp: string[]
  additionalDirectories?: string[]
  readOnly?: boolean
  worktreeName?: string
  communicationFile?: string | null
  /** Bypass skips native permissions. Native honors repository rules; unanswered
   * permission prompts are denied in headless mode. Hooks are not a sandbox. */
  permissionMode?: 'bypass' | 'native'
  timeoutMs: number
  stallMs: number
  graceMs: number
  maxCost?: number
  command?: string
  prefixArgs?: string[]
  onEvent(event: RunnerEvent): void
}

const READ_ONLY_TOOLS = 'Read,Glob,Grep,Skill,ToolSearch,WebFetch,WebSearch'
const MAX_EVENT_BYTES = 8 * 1024 * 1024
const STDERR_TAIL_CHARS = 16000
const KILL_GRACE_CAP_MS = 5000
const TIMEOUT_MESSAGE = 'Se alcanzo el tiempo maximo de ejecucion de este turno.'

let isolationVersionChecked = false

export function assertIsolationVersion(version: string): void {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!match) throw new Error('No pude verificar la version de Claude Code para aislamiento.')
  const [major, minor, patch] = match.slice(1).map(Number)

  if (major < 2 || (major === 2 && (minor < 1 || (minor === 1 && patch < 263)))) {
    throw new Error(
      'El aislamiento de Regent requiere Claude Code >= 2.1.263. Actualiza el CLI; no se ejecutara en el checkout compartido.',
    )
  }
}

export function runnerArgs(
  options: RunnerOptions,
  systemPromptFile = path.join(REGENT_DIR, 'plugins/executor/colleague.md'),
): string[] {
  const native = options.permissionMode === 'native'
  let toolFlags: string[] = []

  if (options.readOnly) {
    toolFlags = ['--tools', READ_ONLY_TOOLS, '--allowedTools', `${READ_ONLY_TOOLS},mcp__*`]
  } else if (native) {
    toolFlags = ['--allowedTools', 'mcp__regent__*']
  }

  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    ...(options.images?.length ? ['--input-format', 'stream-json'] : []),
    '--permission-mode',
    native ? 'manual' : 'bypassPermissions',
    '--permission-prompts',
    'none',
    '--setting-sources',
    'user,project,local',
    ...(options.worktreeName ? ['--worktree', options.worktreeName] : []),
    ...toolFlags,
    ...(options.additionalDirectories ?? []).flatMap((dir) => ['--add-dir', dir]),
    '--append-system-prompt-file',
    systemPromptFile,
    '--plugin-dir',
    path.join(REGENT_DIR, 'plugins/executor'),
    '--mcp-config',
    JSON.stringify({
      mcpServers: {
        regent: {
          type: 'http',
          url: options.toolsUrl,
          headers: { Authorization: `Bearer ${options.token}` },
        },
      },
    }),
    ...(options.sessionId ? ['--resume', options.sessionId] : []),
    ...(options.model ? ['--model', options.model] : []),
    ...(options.maxCost ? ['--max-budget-usd', String(options.maxCost)] : []),
  ]
}

// Stream events

/** Maps one line of the CLI's stream-json output onto the events the core understands. */
export function normalizeEvent(raw: any): RunnerEvent[] {
  switch (raw.type) {
    case 'system':
      return systemEvent(raw)
    case 'stream_event':
      return textDelta(raw)
    case 'assistant':
      return toolUses(raw)
    case 'user':
      return toolResults(raw)
    case 'result':
      return [resultEvent(raw)]
    default:
      return []
  }
}

function systemEvent(raw: any): RunnerEvent[] {
  if (raw.subtype === 'init') {
    return [
      {
        kind: 'init',
        sessionId: raw.session_id,
        mcpServers: raw.mcp_servers ?? [],
        errors: raw.mcp_server_errors ?? [],
        cwd: raw.cwd ?? null,
        skills: raw.skills ?? [],
        agents: raw.agents ?? [],
        tools: raw.tools ?? [],
      },
    ]
  }

  if (raw.subtype === 'api_retry') {
    return [{ kind: 'api_retry', attempt: raw.attempt, error: raw.error }]
  }

  return []
}

/** Only the top-level assistant text streams; subagent output stays inside its tool result. */
function textDelta(raw: any): RunnerEvent[] {
  if (raw.parent_tool_use_id) return []
  const event = raw.event
  if (event?.type !== 'content_block_delta' || event.delta?.type !== 'text_delta') return []
  return [{ kind: 'text_delta', text: event.delta.text }]
}

function toolUses(raw: any): RunnerEvent[] {
  return (raw.message?.content ?? [])
    .filter((c: any) => c.type === 'tool_use')
    .map((c: any) => ({
      kind: 'tool_use',
      id: c.id,
      parentId: raw.parent_tool_use_id,
      name: c.name,
      input: c.input,
    }))
}

function toolResults(raw: any): RunnerEvent[] {
  return (raw.message?.content ?? [])
    .filter((c: any) => c.type === 'tool_result')
    .map((c: any) => ({
      kind: 'tool_result',
      id: c.tool_use_id,
      parentId: raw.parent_tool_use_id,
      background: Boolean(
        raw.tool_use_result?.backgroundTaskId ||
          /running in (?:the )?background/i.test(JSON.stringify(c.content)),
      ),
      error: c.is_error,
      content: c.content,
    }))
}

function resultEvent(raw: any): ResultEvent {
  return {
    kind: 'result',
    text: raw.result ?? '',
    cost: raw.total_cost_usd ?? 0,
    usage: raw.usage ?? {},
    error: Boolean(raw.is_error),
    errors: raw.errors ?? [],
    denials: raw.permission_denials ?? [],
    subtype: raw.subtype,
  }
}

/** MCP servers named in the init errors, whichever shape the CLI used for them. */
function erroredServers(event: InitEvent): string[] {
  if (Array.isArray(event.errors)) {
    return event.errors
      .map((e: any) => (typeof e === 'string' ? e : (e?.name ?? '')))
      .filter(Boolean)
  }

  return Object.keys(event.errors ?? {})
}

function unconnectedServers(event: InitEvent): string[] {
  return (event.mcpServers ?? [])
    .filter((server) => server.status && server.status !== 'connected')
    .map((server) => server.name)
}

/** Why the CLI exit counts as an error, or '' when it finished cleanly. */
function exitError(
  result: ResultEvent | undefined,
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): string {
  if (result?.error) {
    return (
      [...result.errors, result.text].filter(Boolean).join('; ') ||
      result.subtype ||
      'Claude reporto un error.'
    )
  }

  if (code !== 0) {
    if (stderr) return stderr
    return signal ? `Claude termino por señal ${signal}` : `Claude termino con codigo ${code}`
  }

  return result ? '' : 'Claude termino sin evento result.'
}

function outcome(
  fatal: string,
  reason: string,
  error: string,
): Pick<RunnerResult, 'state' | 'failure'> {
  if (fatal) {
    return {
      state: 'failed',
      failure: { source: 'regent', code: 'execution_failed', detail: error },
    }
  }

  if (reason) return { state: 'interrupted', failure: executionFailure(reason) }

  if (error) {
    const failure = executionFailure(error) ?? {
      source: 'claude' as const,
      code: 'execution_failed' as const,
      detail: error,
    }

    return { state: 'failed', failure }
  }

  return { state: 'completed' }
}

// Process

/** Splits a byte stream into complete lines, decoding UTF-8 across chunk boundaries. */
class LineSplitter {
  private decoder = new StringDecoder('utf8')
  private buffer = ''

  push(chunk: Buffer): string[] {
    this.buffer += this.decoder.write(chunk)
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop()!
    return lines
  }

  get pendingChars(): number {
    return this.buffer.length
  }

  discard(): void {
    this.buffer = ''
  }

  /** Whatever is left once the stream ends, with no trailing newline. */
  end(): string {
    const rest = this.buffer + this.decoder.end()
    this.buffer = ''
    return rest
  }
}

function runnerEnv(options: RunnerOptions): NodeJS.ProcessEnv {
  const native = options.permissionMode === 'native'
  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    REGENT_RUN_ID: options.runId,
    REGENT_READ_ONLY: options.readOnly ? '1' : '0',
    REGENT_RUN_TOKEN: options.token,
    REGENT_TOOLS_URL: options.toolsUrl,
    REGENT_READONLY_MCP: JSON.stringify(options.readonlyMcp),
    REGENT_ROOT: options.cwd,
    ...(native ? { REGENT_PERMISSION_MODE: 'repository' } : {}),
    GIT_PAGER: 'cat',
    GH_PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  }

  // Do not inherit a parent interactive session or alternate subscription tokens.
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  // Node watch reports module loads over child IPC, corrupting worker protocols
  // (e.g. Next's jest-worker). Keep watching Regent, not the agent's children.
  delete env.WATCH_REPORT_DEPENDENCIES
  // In bypass the hook is the only guard: never let an inherited var make it abstain.
  if (!native) delete env.REGENT_PERMISSION_MODE
  return env
}

/** One-time checks before the first real CLI launch; skipped for fakes and read-only runs. */
function preflight(options: RunnerOptions): void {
  if (options.worktreeName && !options.command && !isolationVersionChecked) {
    assertIsolationVersion(
      execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 10000 }).trim(),
    )
    isolationVersionChecked = true
  }

  if (options.permissionMode !== 'native' && !options.command && !options.readOnly) {
    ensureTrusted(options.cwd)
    ensureBypassAccepted()
  }
}

type SystemPrompt = ReturnType<typeof createSystemPrompt>

/** A running CLI process: parses its stream, enforces the deadlines and settles the result. */
class RunnerSession {
  readonly done: Promise<RunnerResult>
  private readonly child: ChildProcessWithoutNullStreams
  private readonly options: RunnerOptions
  private readonly systemPrompt: SystemPrompt
  private readonly lines = new LineSplitter()
  private readonly startedAt = Date.now()
  private readonly stall: NodeJS.Timeout
  private timeout: NodeJS.Timeout
  private termTimer?: NodeJS.Timeout
  private killTimer?: NodeJS.Timeout
  private reason = ''
  private fatal = ''
  private stderr = ''
  private streamed = ''
  private result?: ResultEvent
  private lastEvent = Date.now()
  private closed = false

  constructor(child: ChildProcessWithoutNullStreams, options: RunnerOptions, prompt: SystemPrompt) {
    this.child = child
    this.options = options
    this.systemPrompt = prompt
    child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk))
    child.stderr.on('data', (data) => {
      this.stderr = (this.stderr + data.toString()).slice(-STDERR_TAIL_CHARS)
    })
    child.stdin.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') this.abort(error.message)
    })
    child.stdin.end(runnerInput(options))
    this.timeout = setTimeout(() => this.cancel(TIMEOUT_MESSAGE), options.timeoutMs)
    this.stall = setInterval(() => this.checkStall(), Math.min(1000, options.stallMs))
    this.done = new Promise<RunnerResult>((resolve) => {
      child.on('error', (error) => {
        this.fatal = `No pude iniciar Claude: ${error.message}`
      })
      child.on('close', (code, signal) => resolve(this.finish(code, signal)))
    })
  }

  /** Asks the CLI to stop, escalating from SIGINT to SIGKILL as the grace period runs out. */
  cancel(message = 'Detenido por el usuario'): void {
    if (this.closed || this.reason) return
    this.reason = message
    this.signal('SIGINT')
    this.termTimer = setTimeout(() => {
      this.signal('SIGTERM')
      const grace = Math.min(this.options.graceMs, KILL_GRACE_CAP_MS)
      this.killTimer = setTimeout(() => this.signal('SIGKILL'), grace)
    }, this.options.graceMs)
  }

  setTimeoutMs(ms: number): void {
    clearTimeout(this.timeout)
    const remaining = Math.max(1, ms - (Date.now() - this.startedAt))
    this.timeout = setTimeout(() => this.cancel(TIMEOUT_MESSAGE), remaining)
  }

  /** A protocol failure on Regent's side: stop the CLI and report it as such. */
  private abort(message: string): void {
    this.fatal = message
    this.cancel(message)
  }

  private signal(sig: NodeJS.Signals): void {
    try {
      if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, sig)
      else this.child.kill(sig)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }

  private onStdout(chunk: Buffer): void {
    for (const line of this.lines.push(chunk)) this.onLine(line)

    if (this.lines.pendingChars > MAX_EVENT_BYTES) {
      this.lines.discard()
      this.abort('Evento de Claude mayor a 8 MB')
    }
  }

  private onLine(value: string): void {
    if (!value.trim() || this.fatal) return
    let raw: unknown

    try {
      raw = JSON.parse(value)
    } catch (error) {
      this.abort(`Stream de Claude invalido: ${(error as Error).message}`)
      return
    }

    try {
      this.lastEvent = Date.now()
      for (const event of normalizeEvent(raw)) this.onEvent(event)
    } catch (error) {
      this.abort(`No pude procesar un evento de Claude: ${(error as Error).message}`)
    }
  }

  private onEvent(event: RunnerEvent): void {
    this.options.onEvent(event)
    if (event.kind === 'init') this.checkMcp(event)
    if (event.kind === 'text_delta') this.streamed += event.text
    if (event.kind === 'result') this.result = event
  }

  /** Regent's own MCP server carries every core tool, so losing it is fatal. Servers from the
   * repo's or the user's .mcp.json are optional: report them and keep going. */
  private checkMcp(event: InitEvent): void {
    if (!event.sessionId) throw new Error('Claude no devolvio session_id.')
    const unconnected = unconnectedServers(event)
    const degraded = [...new Set([...erroredServers(event), ...unconnected])]

    if (degraded.includes('regent')) {
      throw new Error(
        `El MCP interno de regent no arranco: ${JSON.stringify(event.errors)} ${unconnected.join(', ')}`,
      )
    }

    if (degraded.length) this.options.onEvent({ kind: 'mcp_degraded', servers: degraded })
  }

  private checkStall(): void {
    if (Date.now() - this.lastEvent >= this.options.stallMs) {
      this.cancel('Claude dejo de emitir eventos.')
    }
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): RunnerResult {
    this.systemPrompt.dispose()
    const rest = this.lines.end()
    if (rest) this.onLine(rest)
    this.closed = true
    clearTimeout(this.timeout)
    clearInterval(this.stall)
    clearTimeout(this.termTimer)
    clearTimeout(this.killTimer)
    const error = this.fatal || this.reason || exitError(this.result, code, signal, this.stderr)
    const { state, failure } = outcome(this.fatal, this.reason, error)

    return {
      state,
      text: this.result?.text || this.streamed,
      error,
      cost: this.result?.cost ?? 0,
      usage: this.result?.usage ?? {},
      ...(failure ? { failure } : {}),
    }
  }
}

export function startRunner(options: RunnerOptions): RunnerHandle {
  preflight(options)
  const systemPrompt = createSystemPrompt(options.communicationFile)
  let child: ChildProcessWithoutNullStreams

  try {
    child = spawn(
      options.command ?? 'claude',
      [...(options.prefixArgs ?? []), ...runnerArgs(options, systemPrompt.file)],
      {
        cwd: options.cwd,
        env: runnerEnv(options),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      },
    )
  } catch (error) {
    systemPrompt.dispose()
    throw error
  }

  const session = new RunnerSession(child, options, systemPrompt)

  return {
    done: session.done,
    cancel: (reason) => session.cancel(reason),
    setTimeoutMs: (ms) => session.setTimeoutMs(ms),
  }
}

export function runnerInput(options: Pick<RunnerOptions, 'prompt' | 'images'>): string {
  if (!options.images?.length) return options.prompt
  return (
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          ...options.images.flatMap((image) => [
            { type: 'text', text: image.label },
            {
              type: 'image',
              source: { type: 'base64', media_type: image.mediaType, data: image.data },
            },
          ]),
          { type: 'text', text: options.prompt },
        ],
      },
      parent_tool_use_id: null,
    }) + '\n'
  )
}
