import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import path from 'node:path'
import { BRIDGE_DIR } from '../env.ts'
import { ensureTrusted, ensureBypassAccepted } from '../claude-settings.ts'

export interface RunnerEvent { kind: string; [key: string]: any }
export interface RunnerResult { state: 'completed' | 'failed' | 'interrupted'; text: string; error: string; cost: number; usage: unknown }
export interface RunnerOptions {
  cwd: string; prompt: string; runId: string; sessionId?: string | null; model?: string | null
  env?: NodeJS.ProcessEnv; toolsUrl: string; token: string; readonlyMcp: string[]
  timeoutMs: number; stallMs: number; graceMs: number; maxCost?: number
  command?: string; prefixArgs?: string[]; onEvent(event: RunnerEvent): void
}

export function runnerArgs(options: RunnerOptions): string[] {
  return ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-mode', 'bypassPermissions', '--permission-prompts', 'none',
    '--append-system-prompt-file', path.join(BRIDGE_DIR, 'plugin/colleague.md'),
    '--plugin-dir', path.join(BRIDGE_DIR, 'plugin'),
    '--mcp-config', JSON.stringify({ mcpServers: { regent: { type: 'http', url: options.toolsUrl, headers: { Authorization: `Bearer ${options.token}` } } } }),
    ...(options.sessionId ? ['--resume', options.sessionId] : []),
    ...(options.model ? ['--model', options.model] : []),
    ...(options.maxCost ? ['--max-budget-usd', String(options.maxCost)] : []),
  ]
}

export function normalizeEvent(raw: any): RunnerEvent[] {
  if (raw.type === 'system' && raw.subtype === 'init') return [{ kind: 'init', sessionId: raw.session_id, mcpServers: raw.mcp_servers ?? [], errors: raw.mcp_server_errors ?? [] }]
  if (raw.type === 'system' && raw.subtype === 'api_retry') return [{ kind: 'api_retry', attempt: raw.attempt, error: raw.error }]
  if (raw.type === 'stream_event' && !raw.parent_tool_use_id) {
    const event = raw.event
    if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') return [{ kind: 'text_delta', text: event.delta.text }]
  }
  if (raw.type === 'assistant') return (raw.message?.content ?? []).filter((c: any) => c.type === 'tool_use').map((c: any) => ({ kind: 'tool_use', name: c.name, input: c.input }))
  if (raw.type === 'user') return (raw.message?.content ?? []).filter((c: any) => c.type === 'tool_result').map((c: any) => ({ kind: 'tool_result', id: c.tool_use_id, error: c.is_error, content: c.content }))
  if (raw.type === 'result') return [{ kind: 'result', text: raw.result ?? '', cost: raw.total_cost_usd ?? 0, usage: raw.usage ?? {}, error: Boolean(raw.is_error), errors: raw.errors ?? [], denials: raw.permission_denials ?? [], subtype: raw.subtype }]
  return []
}

export function startRunner(options: RunnerOptions): { done: Promise<RunnerResult>; cancel(reason?: string): void; setTimeoutMs?(ms: number): void } {
  if (!options.command) { ensureTrusted(options.cwd); ensureBypassAccepted() }
  const env = { ...process.env, ...options.env, REGENT_RUN_ID: options.runId, REGENT_RUN_TOKEN: options.token,
    REGENT_TOOLS_URL: options.toolsUrl, REGENT_READONLY_MCP: JSON.stringify(options.readonlyMcp), REGENT_ROOT: options.cwd,
    GIT_PAGER: 'cat', GH_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
  // Do not inherit a parent interactive session or alternate subscription tokens.
  delete env.CLAUDECODE
  delete env.CLAUDE_CODE_OAUTH_TOKEN
  const child = spawn(options.command ?? 'claude', [...(options.prefixArgs ?? []), ...runnerArgs(options)], {
    cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  })
  let reason = '', fatal = '', stderr = '', buffer = '', streamed = '', result: RunnerEvent | undefined
  let lastEvent = Date.now(), closed = false
  let termTimer: NodeJS.Timeout | undefined, killTimer: NodeJS.Timeout | undefined
  const signal = (sig: NodeJS.Signals) => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig)
      else child.kill(sig)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
  const cancel = (message = 'Detenido por el usuario') => {
    if (closed || reason) return
    reason = message
    signal('SIGINT')
    termTimer = setTimeout(() => {
      signal('SIGTERM')
      killTimer = setTimeout(() => signal('SIGKILL'), Math.min(options.graceMs, 5000))
    }, options.graceMs)
  }
  const emit = (event: RunnerEvent) => {
    options.onEvent(event)
    if (event.kind === 'init') {
      if (!event.sessionId) throw new Error('Claude no devolvio session_id.')
      const errorNames = (Array.isArray(event.errors) ? event.errors.map((e: any) => typeof e === 'string' ? e : e?.name ?? '') : Object.keys(event.errors ?? {})).filter(Boolean)
      const failed = (event.mcpServers ?? []).filter((s: any) => s.status && s.status !== 'connected').map((s: any) => s.name)
      const degraded = [...new Set([...errorNames, ...failed])]
      // The internal 'regent' server (see runnerArgs) carries every core tool: its failure is fatal.
      // Servers from the user's or repo's own .mcp.json are optional here — report, don't abort.
      if (degraded.includes('regent')) throw new Error(`El MCP interno de regent no arranco: ${JSON.stringify(event.errors)} ${failed.join(', ')}`)
      if (degraded.length) options.onEvent({ kind: 'mcp_degraded', servers: degraded })
    }
    if (event.kind === 'text_delta') streamed += event.text
    if (event.kind === 'result') result = event
  }
  const line = (value: string) => {
    if (!value.trim() || fatal) return
    try {
      const raw = JSON.parse(value)
      lastEvent = Date.now()
      for (const event of normalizeEvent(raw)) emit(event)
    } catch (error) { fatal = `Stream de Claude invalido: ${(error as Error).message}`; cancel(fatal) }
  }
  const decoder = new StringDecoder('utf8')
  child.stdout.on('data', chunk => {
    buffer += decoder.write(chunk)
    let index: number
    while ((index = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, index)); buffer = buffer.slice(index + 1) }
    if (buffer.length > 8 * 1024 * 1024) { fatal = 'Evento de Claude mayor a 8 MB'; buffer = ''; cancel(fatal) }
  })
  child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-16000) })
  child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') { fatal = error.message; cancel(fatal) } })
  child.stdin.end(options.prompt)
  const startedAt = Date.now()
  const timedOut = () => cancel('Se alcanzo el tiempo maximo; escribe continua para retomar.')
  let timeout = setTimeout(timedOut, options.timeoutMs)
  const setTimeoutMs = (ms: number) => { clearTimeout(timeout); timeout = setTimeout(timedOut, Math.max(1, ms - (Date.now() - startedAt))) }
  const stall = setInterval(() => { if (Date.now() - lastEvent >= options.stallMs) cancel('Claude dejo de emitir eventos; escribe continua para retomar.') }, Math.min(1000, options.stallMs))
  const done = new Promise<RunnerResult>(resolve => {
    child.on('error', error => { fatal = `No pude iniciar Claude: ${error.message}` })
    child.on('close', code => {
      buffer += decoder.end()
      if (buffer) line(buffer)
      closed = true
      clearTimeout(timeout); clearInterval(stall); clearTimeout(termTimer); clearTimeout(killTimer)
      const error = fatal || reason || (code !== 0 ? stderr || `Claude termino con codigo ${code}` : !result ? 'Claude termino sin evento result.' : result.error ? result.errors.join('; ') || result.subtype || 'Claude reporto un error.' : '')
      resolve({ state: fatal ? 'failed' : reason ? 'interrupted' : error ? 'failed' : 'completed', text: result?.text || streamed, error, cost: result?.cost ?? 0, usage: result?.usage ?? {} })
    })
  })
  return { done, cancel, setTimeoutMs }
}
