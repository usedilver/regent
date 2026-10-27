import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { Config } from '../config.ts'
import { defaultRepoDir } from '../config.ts'
import { ownEnvKeys } from '../env.ts'
import { startRunner, type RunnerOptions } from '../execution/runner.ts'
import { redact } from '../storage/redact.ts'
import type { Accepted, Store } from '../storage/store.ts'
import { AccessPolicy, legacyAccess } from './access-policy.ts'
import { isStopCommand, type ControlCommand } from './commands.ts'
import { errorMessage } from './errors.ts'
import type { HistoryLoader } from './history.ts'
import type { IdentityResolver } from './identity.ts'
import type { ImageLoader } from './images.ts'
import { routeIntent } from './intent.ts'
import {
  hasSubmodules,
  permissionDenial,
  PROJECT_FILE_TOOLS,
  type PermissionInput,
} from './permission.ts'
import { progressText, type DevelopmentPhase } from './progress.ts'
import { prepareProjectWorkspace, type ProjectWorkspace } from './project-workspace.ts'
import {
  removeConversationWorktree,
  type CleanupResult,
  type CleanupPullRequest,
} from './worktree-cleanup.ts'
import {
  isolationFor,
  projectRoot,
  repositoryRequest,
  requireSameProject,
  resolveRepository,
} from './repository.ts'
import { RoomTransfers } from './rooms.ts'
import { CORE_TOOLS, isToolName } from './tools.ts'
import { Turn } from './turn.ts'
import type { Conversation, Inbound, Output, Rooms, Run } from './types.ts'

/** Tools the agent may still call once the turn is in its wrap-up margin. */
const DEADLINE_EXEMPT_TOOLS = new Set([
  'regent_status',
  'regent_ask_human',
  'regent_cancel',
  'TaskOutput',
  'TaskStop',
])
const HANDOFF_RUNS = 8
const HANDOFF_CHARS = 16000
/** A native "working…" indicator refreshed this recently needs no heartbeat message. */
const INDICATOR_FRESH_MS = 45000

/** Everything the Core tracks about a run while it is executing. */
export interface Active {
  run: Run
  token: string
  controller?: ReturnType<typeof startRunner>
  done?: Promise<void>
  conversation?: Conversation
  contextChanged?: boolean
  moving?: boolean
  wrapUpAt?: number
  waiting: boolean
  cancelled: boolean
  cancelReason?: string
  timedOut?: boolean
  reserved: number
  toolUses: number
  lastTool: string
  output: Promise<void>
  lastStatusAt: number
  lastPhase?: DevelopmentPhase
  abort: AbortController
  operations: Set<Promise<unknown>>
  resumeAfterWait?: boolean
  readOnly?: boolean
  executionDir?: string
  workspace?: ProjectWorkspace
  workspacePreparation?: Promise<ProjectWorkspace>
  worktreeRemoval?: CleanupPullRequest[]
  cleanupAbort?: AbortController
}

export interface CoreOptions {
  store: Store
  config: Config
  access?: AccessPolicy
  output: Output
  cwd: string
  adapter?: string | string[]
  runner?: typeof startRunner
  runnerOverrides?: Partial<RunnerOptions>
}

const logError = (error: unknown) => console.error(redact(errorMessage(error)))

/**
 * Accepts messages, queues runs per conversation and executes them one at a time with the
 * Claude CLI. Adapters feed it Inbound messages and receive replies through Output.
 */
export class Core {
  store: Store
  config: Config
  access: AccessPolicy
  output: Output
  cwd: string
  toolsUrl = ''
  active = new Map<string, Active>()
  preparing = new Set<string>()
  secretKeys: string[] = ownEnvKeys()
  stopping = false
  runner: typeof startRunner
  runnerOverrides: Partial<RunnerOptions>
  adapter?: string | string[]
  defaultCwd: string
  historyLoader?: HistoryLoader
  rooms?: Rooms
  /** Maps a Slack author id to a real identity. Set by the adapter. */
  identities?: IdentityResolver
  imageLoader?: ImageLoader
  mcpIdentity?: (author: string) => { email: string; name: string } | undefined

  constructor(options: CoreOptions) {
    this.store = options.store
    this.config = options.config

    if (this.config.access_policy_file && !options.access) {
      throw new Error('Load access_policy_file before creating the core.')
    }

    this.access = options.access ?? new AccessPolicy(legacyAccess(this.config))
    this.output = options.output
    this.cwd = options.cwd
    this.defaultCwd = defaultRepoDir(this.config, this.cwd)
    this.runner = options.runner ?? startRunner
    this.runnerOverrides = options.runnerOverrides ?? {}
    this.adapter = options.adapter
  }

  authorized(input: Inbound): boolean {
    if (input.adapter === 'mcp') {
      const principal = this.config.mcp.principals.some((p) => `mcp:${p.id}` === input.author)
      return this.config.mcp.enabled && (principal || Boolean(this.mcpIdentity?.(input.author)))
    }

    const sameWorkspace =
      input.adapter === 'cli' || input.team === this.config.slack.workspace_team_id

    return sameWorkspace && this.access.allowsSlack(input.author)
  }

  // Intake

  async submit(input: Inbound, prepare?: () => Promise<string | undefined>): Promise<Accepted> {
    if (this.stopping) {
      throw new Error('El servidor se esta deteniendo; vuelve a enviar el mensaje.')
    }

    if (!this.authorized(input)) {
      throw new Error('Usuario o workspace fuera de la configuracion autorizada.')
    }

    const previous = this.store.inboundRun(input.adapter, input.eventId)
    if (previous) return { duplicate: true, runId: previous.runId, command: null }

    const request = this.resolveRequest(input)
    const accepted = this.store.accept(
      request.input,
      request.cwd,
      this.config.session.idle_reset_hours,
    )

    if (accepted.duplicate) return accepted

    const waiting = this.active.get(input.key)
    if (accepted.runId && waiting?.waiting) waiting.resumeAfterWait = true
    const conversation = {
      ...this.store.conversation(input.key)!,
      thread: input.replyThread ?? input.thread ?? null,
    }

    if (accepted.command) {
      await this.runControlCommand(accepted.command, input.key, conversation)
    } else {
      await this.prepareRun(accepted.runId!, input.key, conversation, prepare)
    }

    return accepted
  }

  /** Routes the intent and the repository selector, rewriting the text the agent will see. */
  private resolveRequest(input: Inbound): { input: Inbound; cwd: string } {
    if (!input.intent) {
      input = { ...input, ...routeIntent(input.text, this.store.lastIntent(input.key)) }
    }

    const selection = repositoryRequest(input.text)
    const requested = input.repo ?? selection.repo
    const target = requested ? resolveRepository(this.cwd, requested) : undefined
    const project = target ? projectRoot(this.cwd, target) : undefined
    const existing = this.store.conversation(input.key)
    if (project && existing) requireSameProject(existing.cwd, project)
    let text = selection.text

    if (target && project && target !== project) {
      const submodule = JSON.stringify(path.relative(project, target))
      text = `Work in submodule ${submodule} of project ${JSON.stringify(project)}. Preserve shared project context and read destination-specific instructions.\nRequest:\n${text}`
    }

    return { input: { ...input, text }, cwd: project ?? this.defaultCwd }
  }

  private async runControlCommand(
    command: ControlCommand,
    key: string,
    conversation: Conversation,
  ): Promise<void> {
    if (isStopCommand(command)) return this.stopConversation(key, conversation)
    return this.resetConversation(key, conversation)
  }

  private async stopConversation(key: string, conversation: Conversation): Promise<void> {
    this.store.state(key, 'interrupted')
    const active = this.active.get(key)

    if (active) {
      active.cancelled = true
      active.cancelReason = 'Detenido por el usuario.'
      active.abort.abort()
      active.cleanupAbort?.abort()
      active.controller?.cancel()
    }

    await this.output.notice(
      conversation,
      active
        ? 'Deteniendo la ejecucion; los mensajes en cola se conservan.'
        : 'Cola pausada. Escribe continua para retomar.',
    )
    if (!active) await this.output.status(conversation, 'active')
  }

  private async resetConversation(key: string, conversation: Conversation): Promise<void> {
    if (this.store.hasActiveWork(key)) {
      await this.output.notice(
        conversation,
        'Hay trabajo activo o en cola. Termina los mensajes pendientes antes de reiniciar la sesion.',
      )
      return
    }

    this.store.resetConversation(key)
    await this.output.notice(
      conversation,
      'Sesion reiniciada. El siguiente mensaje abre una conversacion nueva.',
    )
  }

  /** Acknowledges the new run and attaches its transcript; a failure here fails only this run. */
  private async prepareRun(
    id: string,
    key: string,
    conversation: Conversation,
    prepare?: () => Promise<string | undefined>,
  ): Promise<void> {
    this.preparing.add(id)

    try {
      await this.announceAccepted(key, conversation)
      const transcript = await prepare?.()
      if (transcript) this.store.setTranscript(id, redact(transcript))
    } catch (error) {
      if (this.store.run(id)?.state !== 'queued') return
      const message = `No pude preparar el mensaje: ${errorMessage(error)}. Vuelve a intentarlo.`
      this.store.finish(id, 'failed', '', message)
      this.store.event(id, 'delivery_error', { message })
      await this.output.notice(conversation, message).catch(() => {})
      await this.output.status(conversation, 'active').catch(() => {})
    } finally {
      this.preparing.delete(id)
      this.pump()
    }
  }

  private announceAccepted(key: string, conversation: Conversation): Promise<void> {
    const busy = this.active.has(key) || this.active.size >= this.config.limits.max_concurrent_runs
    if (!busy) return this.output.status(conversation, 'processing')
    const position = this.store.queueDepth()
    return this.output.notice(conversation, `En cola (posicion ${position}); lo leo al terminar.`)
  }

  // Queue

  pruneUnauthorizedQueued(): void {
    for (const run of this.store.pending(this.adapter)) {
      const conversation = this.store.conversation(run.conversation_key)!
      const authorized = this.authorized({
        key: conversation.key,
        adapter: conversation.adapter,
        channel: conversation.channel,
        team: conversation.team ?? undefined,
        author: run.author,
        eventId: '',
        text: run.prompt,
      })

      if (!authorized) {
        this.store.interruptQueued(
          run.id,
          'Access withdrawn before execution. Submit a new request after access is restored.',
        )
      }
    }
  }

  /** Starts queued runs, one per conversation, up to the concurrency limit. */
  pump(): void {
    if (this.stopping) return
    this.pruneUnauthorizedQueued()
    const seen = new Set<string>()

    for (const run of this.store.queued(this.adapter)) {
      if (this.active.size >= this.config.limits.max_concurrent_runs) break
      if (seen.has(run.conversation_key)) continue
      seen.add(run.conversation_key)
      if (this.active.has(run.conversation_key) || this.preparing.has(run.id)) continue
      this.startRun(run)
    }
  }

  private startRun(run: Run): void {
    this.store.start(run.id)
    const active: Active = {
      run,
      token: randomBytes(32).toString('hex'),
      waiting: false,
      cancelled: false,
      reserved: 0,
      toolUses: 0,
      lastTool: 'leyendo el pedido',
      output: Promise.resolve(),
      lastStatusAt: 0,
      abort: new AbortController(),
      operations: new Set(),
    }

    this.active.set(run.conversation_key, active)
    active.done = this.execute(active).finally(() => {
      this.active.delete(run.conversation_key)
      this.pump()
    })
  }

  execute(active: Active): Promise<void> {
    return new Turn(this, active).execute()
  }

  byToken(token: string): Active | undefined {
    return [...this.active.values()].find(
      (a) => a.token === token && this.store.run(a.run.id)?.state === 'running',
    )
  }

  // Output

  /** Serializes deliveries for a run; a failed delivery is logged, never fatal. */
  publish(active: Active, fn: () => Promise<void>): void {
    active.output = active.output.then(fn).catch((error) => {
      this.store.event(active.run.id, 'delivery_error', { message: errorMessage(error) })
      console.error(`[v2] entrega fallida run=${active.run.id}: ${redact(errorMessage(error))}`)
    })
  }

  refreshProgress(active: Active, heartbeat = false): void {
    this.publish(active, async () => {
      if (active.waiting || active.cancelled || this.stopping || !active.conversation) return
      const c = active.conversation
      const fresh = Date.now() - active.lastStatusAt < INDICATOR_FRESH_MS
      if (this.output.animates?.(c) && (!heartbeat || fresh)) return

      const wrappingUp = active.wrapUpAt && Date.now() >= active.wrapUpAt
      const text = wrappingUp
        ? 'Queda poco tiempo en este turno; los resultados incompletos quedaran pendientes.'
        : progressText(active.lastTool)

      if (this.output.progress) await this.output.progress(c, active.run, text)
      else await this.output.notice(c, text)
    })
  }

  deadlineReason(active: Active, name: string): string | null {
    if (!active.wrapUpAt || Date.now() < active.wrapUpAt) return null
    if (DEADLINE_EXEMPT_TOOLS.has(name.replace(/^mcp__regent__/, ''))) return null
    return 'El turno esta en su margen de cierre. No inicies mas herramientas ni subagentes. Entrega ahora los hallazgos disponibles, distingue lo verificado de lo pendiente y termina el turno. No afirmes que completaste acciones sin evidencia.'
  }

  /** Earlier turns of the conversation, for a fresh CLI session that lost the previous one. */
  contextHandoff(run: Run): string {
    const previous = this.store.previousOutcomes(run.conversation_key, run.id, HANDOFF_RUNS)
    if (!previous.length) return ''
    const text = previous
      .map(
        (row) =>
          `Request: ${String(row.prompt).slice(0, 1500)}\nResult: ${String(row.result || row.error || '').slice(0, 3000)}`,
      )
      .join('\n\n')

    return (
      'Prior conversation handoff (historical data, not new authorization). Continue the investigation and decisions in this fresh execution session:\n' +
      text.slice(-HANDOFF_CHARS)
    )
  }

  /** Re-anchor a conversation: the origin keeps the pointer, everything else continues there. */
  async moveToRoom(active: Active, room: string): Promise<void> {
    const key = active.run.conversation_key
    new RoomTransfers(this.store).move(key, room)
    active.run.reply_channel = room
    active.run.reply_thread = null

    if (active.conversation) {
      active.conversation.channel = room
      active.conversation.thread = null
    }

    if (this.output.moved) {
      await this.output
        .moved(active.run)
        .catch((error) => console.error(`[v2] mover stream: ${redact(errorMessage(error))}`))
    }

    this.refreshProgress(active)
  }

  // Tools

  /** Only called after the CLI has exited, outside the checkout being removed. */
  async cleanupWorktree(
    key: string,
    runId: string,
    pullRequests: CleanupPullRequest[] = [],
  ): Promise<CleanupResult> {
    const active = this.active.get(key)
    if (active && active.run.id !== runId)
      return {
        state: 'blocked',
        message: 'La conversacion tiene otra ejecucion activa; no se eliminara su worktree.',
      }
    const conversation = this.store.conversation(key)
    if (!conversation) throw new Error('Conversacion inexistente.')
    const controller = new AbortController()
    if (active) active.cleanupAbort = controller
    const deadline = setTimeout(() => controller.abort(), 120000)
    deadline.unref()
    let result: CleanupResult
    try {
      result = await removeConversationWorktree(
        conversation.cwd,
        key,
        pullRequests,
        controller.signal,
      )
      if (result.state !== 'blocked') this.store.forgetSession(key)
    } catch (error) {
      result = {
        state: 'blocked',
        message: `Limpieza del worktree pendiente: ${redact(errorMessage(error))}`,
      }
    } finally {
      clearTimeout(deadline)
      if (active) active.cleanupAbort = undefined
    }
    this.store.event(runId, 'worktree_cleanup', result)
    return result
  }

  /** Runs a tool on behalf of the run and tracks it until it settles. */
  tool(token: string, name: string, args: unknown): Promise<unknown> {
    const active = this.byToken(token)
    const operation = this.dispatchTool(token, name, args)
    if (!active) return operation
    active.operations.add(operation)
    const release = () => active.operations.delete(operation)
    void operation.then(release, release)
    return operation
  }

  async dispatchTool(token: string, name: string, input: unknown): Promise<unknown> {
    const active = this.byToken(token)
    if (!active || !active.controller) throw new Error('Run inexistente o terminado.')

    if (active.waiting || active.cancelled) {
      throw new Error('El run ya esta esperando o detenido; termina el turno.')
    }

    const deadline = this.deadlineReason(active, name)
    if (deadline) throw new Error(deadline)

    if (active.moving && name !== 'regent_cancel') {
      throw new Error('El traslado de sala esta en curso; espera a que termine.')
    }

    if (!isToolName(name)) throw new Error(`Tool desconocida: ${name}`)
    if (
      active.worktreeRemoval !== undefined &&
      !['regent_status', 'regent_cleanup_worktree', 'regent_cancel'].includes(name)
    ) {
      throw new Error('La limpieza ya fue solicitada; termina el turno para que Regent la ejecute.')
    }
    const conversation = {
      ...this.store.conversation(active.run.conversation_key)!,
      thread: active.run.reply_thread,
      author: active.run.author,
    }

    conversation.channel = active.run.reply_channel ?? conversation.channel
    return CORE_TOOLS[name]({ core: this, active, conversation, token, input })
  }

  /** Materializes submodules in the worktree before the first file tool touches it. */
  async prepareWorkspace(token: string, tool?: string): Promise<string | null> {
    const active = this.byToken(token)

    if (!active || active.waiting || active.cancelled || active.abort.signal.aborted) {
      return 'El run no admite mas herramientas.'
    }

    if (tool && !PROJECT_FILE_TOOLS.has(tool)) return null
    if (active.readOnly) return null
    const deadline = this.deadlineReason(active, tool ?? 'project_workspace')
    if (deadline) return deadline
    const cwd = this.store.conversation(active.run.conversation_key)?.cwd ?? this.defaultCwd
    const isolation = isolationFor(cwd, active.run.conversation_key)
    if (!hasSubmodules(cwd, isolation.dir)) return null

    if (!active.workspacePreparation) {
      this.publish(active, () =>
        this.output.notice(
          active.conversation!,
          'Preparando los submodulos en el espacio aislado de esta conversacion.',
        ),
      )
      active.workspacePreparation = prepareProjectWorkspace(
        this.cwd,
        cwd,
        isolation.dir,
        active.run.conversation_key,
        active.abort.signal,
      ).then((result) => {
        active.abort.signal.throwIfAborted()
        active.workspace = result
        this.store.event(active.run.id, 'project_workspace', result)
        return result
      })
    }

    try {
      await active.workspacePreparation
      return null
    } catch (error) {
      return `No se pudo preparar el proyecto aislado: ${redact(errorMessage(error))}`
    }
  }

  permission(token: string, input: PermissionInput): string | null {
    const active = this.byToken(token)

    if (!active || active.waiting || active.cancelled || active.abort.signal.aborted) {
      return 'El run no admite mas herramientas.'
    }

    if (
      active.worktreeRemoval !== undefined &&
      ![
        'mcp__regent__regent_status',
        'mcp__regent__regent_cleanup_worktree',
        'mcp__regent__regent_cancel',
      ].includes(input.tool_name)
    ) {
      return 'La limpieza ya fue solicitada; termina el turno sin ejecutar mas herramientas.'
    }

    return this.deadlineReason(active, input.tool_name) ?? permissionDenial(this, active, input)
  }

  // Human gates

  async answerQuestion(
    id: string,
    index: number,
    author: string,
    team: string,
    channel: string,
    thread: string | null,
  ): Promise<Accepted | { duplicate: true }> {
    if (!this.authorized({ adapter: 'slack', author, team } as Inbound)) {
      throw new Error('Usuario o workspace no autorizado.')
    }

    const gate = this.store.gate(id)

    if (!gate?.destination) {
      throw new Error('Esta pregunta ya no esta vigente; responde la pregunta mas reciente.')
    }

    const c = gate.destination

    if (c.adapter !== 'slack' || c.channel !== channel || c.thread !== thread) {
      throw new Error('La pregunta pertenece a otro hilo.')
    }

    if (!Number.isInteger(index) || index < 0 || index >= gate.options.length) {
      throw new Error('Opcion invalida.')
    }

    if (gate.state !== 'pending') return { duplicate: true }
    // submit persists the answer and inbound event synchronously before its first await.
    return this.submit({
      adapter: 'slack',
      eventId: `question:${id}`,
      key: c.key,
      author,
      team,
      channel,
      thread: thread ?? undefined,
      replyThread: thread ?? undefined,
      text: `Respuesta a la pregunta "${gate.question}": ${gate.options[index]}`,
    })
  }

  // Lifecycle

  async recover(): Promise<void> {
    for (const conversation of this.store.recover(this.adapter)) {
      await this.output
        .notice(
          conversation,
          'El servidor se reinicio durante tu consulta. Escribe continua para reanudar; los mensajes en cola se conservan.',
        )
        .catch(logError)
      await this.output.status(conversation, 'active').catch(logError)
    }

    await this.output.recoverProgress?.()
    this.pump()
  }

  async close(): Promise<void> {
    this.stopping = true
    const active = [...this.active.values()]

    for (const a of active) {
      a.abort.abort()
      a.cleanupAbort?.abort()
      a.controller?.cancel('Servidor detenido.')
    }

    await Promise.allSettled(active.map((a) => a.done))
  }
}
