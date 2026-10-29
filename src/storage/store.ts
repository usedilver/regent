import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { Conversation, ConversationState, Inbound, Run, RunState } from '../core/types.ts'
import { controlCommand, type ControlCommand } from '../core/commands.ts'
import { commandDisplay } from '../core/command-display.ts'
import { migrate } from './schema.ts'
import { redact, redactDeep } from './redact.ts'

export interface Accepted {
  duplicate: boolean
  runId: string | null
  command: ControlCommand | null
}

export interface GateQuestion {
  id: string
  text: string
  options: string[]
}

type FinalRunState = Exclude<RunState, 'queued' | 'running'>
type AdapterFilter = string | string[] | undefined

const today = () => new Date().toISOString().slice(0, 10)

/** JSON list for the `IN (SELECT value FROM json_each(?))` clauses, or null to accept every adapter. */
function adapterList(adapter: AdapterFilter): string | null {
  if (adapter === undefined) return null
  return JSON.stringify(Array.isArray(adapter) ? adapter : [adapter])
}

export class Store {
  db: DatabaseSync
  owner = randomUUID()
  ownsRuntime = false

  constructor(file: string) {
    if (file !== ':memory:') {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      fs.closeSync(fs.openSync(file, 'a', 0o600))
      fs.chmodSync(file, 0o600)
    }

    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    this.transaction(() => migrate(this.db))
  }

  claimRuntime(): void {
    this.transaction(() => {
      const existing = this.db.prepare('SELECT pid FROM runtime WHERE id=1').get()

      if (existing && processAlive(existing.pid as number)) {
        throw new Error(
          `Esta base ya tiene un runtime activo (PID ${existing.pid}). Usa otra REGENT_DB o deten ese proceso.`,
        )
      }

      this.db.prepare('INSERT OR REPLACE INTO runtime VALUES(1,?,?)').run(process.pid, this.owner)
      this.ownsRuntime = true
    })
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')

    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  // Lookups

  conversation(key: string): Conversation | undefined {
    return this.db.prepare('SELECT * FROM conversations WHERE key=?').get(key) as unknown as
      | Conversation
      | undefined
  }

  run(id: string): Run | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as unknown as Run | undefined
  }

  latestRun(key: string): Run | undefined {
    return this.db
      .prepare(
        'SELECT * FROM runs WHERE conversation_key=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
      )
      .get(key) as unknown as Run | undefined
  }

  /** The conversation that owns a managed room: anchored at channel root, not in a thread. */
  roomConversationKey(channel: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT key FROM conversations WHERE adapter='slack' AND channel=? AND thread IS NULL",
      )
      .get(channel)

    return row?.key as string | undefined
  }

  /** The run an inbound event created the first time it arrived, when it was seen before. */
  inboundRun(adapter: string, eventId: string): { runId: string | null } | undefined {
    const row = this.db
      .prepare('SELECT run_id FROM inbound WHERE adapter=? AND event_id=?')
      .get(adapter, eventId)

    return row ? { runId: row.run_id as string | null } : undefined
  }

  hasQueued(key: string): boolean {
    return this.hasRunIn(key, ['queued'])
  }

  hasActiveWork(key: string): boolean {
    return this.hasRunIn(key, ['queued', 'running'])
  }

  queueDepth(): number {
    return this.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE state='queued'").get()!.n as number
  }

  pendingDeliveries(): number {
    return this.db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE state='pending'").get()!
      .n as number
  }

  healthy(): boolean {
    return this.db.prepare('SELECT 1 AS ok').get()!.ok === 1
  }

  runCounts(): Array<{ state: RunState; n: number }> {
    return this.db
      .prepare('SELECT state,COUNT(*) AS n FROM runs GROUP BY state')
      .all() as unknown as Array<{ state: RunState; n: number }>
  }

  recentRuns(limit: number): unknown[] {
    return this.db
      .prepare(
        'SELECT id,conversation_key,state,cost,error FROM runs ORDER BY created_at DESC LIMIT ?',
      )
      .all(limit)
  }

  /** Finished runs of a conversation other than `excluding`, oldest first. */
  previousOutcomes(
    key: string,
    excluding: string,
    limit: number,
  ): Array<{ prompt: string; result: string | null; error: string | null }> {
    return this.db
      .prepare(
        "SELECT prompt,result,error FROM runs WHERE conversation_key=? AND id<>? AND state NOT IN ('queued','running') ORDER BY created_at DESC,rowid DESC LIMIT ?",
      )
      .all(key, excluding, limit)
      .reverse() as unknown as Array<{
      prompt: string
      result: string | null
      error: string | null
    }>
  }

  eventsAfter(runId: string, cursor: number): Array<{ id: number; kind: string; data: string }> {
    return this.db
      .prepare('SELECT id,kind,data FROM events WHERE run_id=? AND id>? ORDER BY id')
      .all(runId, cursor) as unknown as Array<{ id: number; kind: string; data: string }>
  }

  /** Parsed data of the newest event of that kind, or undefined. */
  lastEvent<T = unknown>(runId: string, kind: string): T | undefined {
    const row = this.db
      .prepare('SELECT data FROM events WHERE run_id=? AND kind=? ORDER BY id DESC LIMIT 1')
      .get(runId, kind)

    return row ? (JSON.parse(row.data as string) as T) : undefined
  }

  queued(adapter?: AdapterFilter): Run[] {
    const adapters = adapterList(adapter)

    return this.db
      .prepare(
        "SELECT r.* FROM runs r JOIN conversations c ON c.key=r.conversation_key WHERE r.state='queued' AND c.state='queued' AND (? IS NULL OR c.adapter IN (SELECT value FROM json_each(?))) ORDER BY r.created_at,r.rowid",
      )
      .all(adapters, adapters) as unknown as Run[]
  }

  pending(adapter?: AdapterFilter): Run[] {
    const adapters = adapterList(adapter)

    return this.db
      .prepare(
        "SELECT r.* FROM runs r JOIN conversations c ON c.key=r.conversation_key WHERE r.state='queued' AND (? IS NULL OR c.adapter IN (SELECT value FROM json_each(?))) ORDER BY r.created_at,r.rowid",
      )
      .all(adapters, adapters) as unknown as Run[]
  }

  spent(author: string): number {
    return this.db
      .prepare('SELECT COALESCE(SUM(cost),0) AS cost FROM usage WHERE author=? AND day=?')
      .get(author, today())!.cost as number
  }

  // Intake

  accept(input: Inbound, cwd: string, idleHours: number, switchContext = false): Accepted {
    return this.transaction(() => {
      const previous = this.inboundRun(input.adapter, input.eventId)
      if (previous) return { duplicate: true, runId: previous.runId, command: null }

      const now = Date.now()
      const conversation = this.ensureConversation(input, cwd, now)
      if (sessionExpired(conversation, input, now, idleHours)) this.forgetSession(input.key)

      const command = controlCommand(input.text)
      const id = command ? null : randomUUID()
      this.db.prepare('INSERT INTO inbound VALUES(?,?,?)').run(input.adapter, input.eventId, id)
      this.db
        .prepare(
          "UPDATE conversations SET author=?, updated_at=?, cwd=CASE WHEN cwd='' THEN ? ELSE cwd END, team=COALESCE(team,?) WHERE key=?",
        )
        .run(input.author, now, cwd, input.team ?? null, input.key)

      if (id) {
        this.createRun(id, input, now)
        this.attachHistory(id, input)
        this.answerGate(input.key, input.text)
        if (conversation.state !== 'running') this.state(input.key, 'queued')
      }

      if (switchContext && id) {
        this.db
          .prepare('UPDATE conversations SET cwd=?,session_id=NULL,session_cwd=NULL WHERE key=?')
          .run(cwd, input.key)
      }

      return { duplicate: false, runId: id, command }
    })
  }

  private ensureConversation(input: Inbound, cwd: string, now: number): Conversation {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO conversations(key,adapter,channel,thread,team,author,cwd,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        input.key,
        input.adapter,
        input.channel,
        input.thread ?? null,
        input.team ?? null,
        input.author,
        cwd,
        now,
      )

    return this.conversation(input.key)!
  }

  private createRun(id: string, input: Inbound, now: number): void {
    this.db
      .prepare(
        'INSERT INTO runs(id,conversation_key,author,prompt,transcript,reply_thread,reply_channel,intent,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        input.key,
        input.author,
        redact(input.text),
        input.transcript ? redact(input.transcript) : null,
        input.replyThread ?? input.thread ?? null,
        input.channel,
        input.intent ?? 'task',
        'queued',
        now,
      )
  }

  /** Slack runs remember where their thread history comes from, so later turns can reread it. */
  private attachHistory(id: string, input: Inbound): void {
    const history =
      input.history ?? (input.adapter === 'slack' ? this.conversationHistory(input.key) : undefined)

    if (!history) return

    const source = typeof history === 'string' ? history : JSON.stringify(history)
    this.db.prepare('INSERT INTO run_history(run_id,source) VALUES(?,?)').run(id, source)
    if (!input.history) return

    this.db
      .prepare(
        'INSERT INTO conversation_history VALUES(?,?) ON CONFLICT(conversation_key) DO UPDATE SET source=excluded.source',
      )
      .run(
        input.key,
        JSON.stringify({ channel: input.history.channel, thread: input.history.thread }),
      )
  }

  private conversationHistory(key: string): string | undefined {
    const row = this.db
      .prepare('SELECT source FROM conversation_history WHERE conversation_key=?')
      .get(key)

    return row?.source as string | undefined
  }

  // Conversation state

  state(key: string, state: ConversationState): void {
    this.db.prepare('UPDATE conversations SET state=? WHERE key=?').run(state, key)
  }

  session(key: string, id: string, directory?: string): void {
    this.db
      .prepare('UPDATE conversations SET session_id=?,session_cwd=? WHERE key=?')
      .run(id, directory ?? null, key)
  }

  /** Drops the CLI session pointer; the next turn starts a fresh session in the same project. */
  forgetSession(key: string): void {
    this.db
      .prepare('UPDATE conversations SET session_id=NULL,session_cwd=NULL WHERE key=?')
      .run(key)
  }

  /** The user's explicit reset: fresh session, idle state and no pending question. */
  resetConversation(key: string): void {
    this.transaction(() => {
      this.db
        .prepare(
          "UPDATE conversations SET session_id=NULL,session_cwd=NULL,state='idle' WHERE key=?",
        )
        .run(key)
      this.db.prepare('DELETE FROM gates WHERE conversation_key=?').run(key)
    })
  }

  // Run lifecycle

  interruptQueued(id: string, reason: string): void {
    this.transaction(() => {
      const run = this.run(id)
      if (!run || run.state !== 'queued') return
      this.db
        .prepare(
          "UPDATE runs SET state='interrupted',error=?,ended_at=? WHERE id=? AND state='queued'",
        )
        .run(reason, Date.now(), id)

      if (!this.hasQueued(run.conversation_key)) {
        this.db
          .prepare("UPDATE conversations SET state='interrupted' WHERE key=? AND state='queued'")
          .run(run.conversation_key)
      }
    })
  }

  start(id: string): void {
    this.transaction(() => {
      this.db
        .prepare("UPDATE runs SET state='running',started_at=? WHERE id=? AND state='queued'")
        .run(Date.now(), id)
      this.state(this.run(id)!.conversation_key, 'running')
    })
  }

  finish(
    id: string,
    state: FinalRunState,
    result = '',
    error = '',
    acknowledge?: () => void,
  ): void {
    this.transaction(() => {
      this.db
        .prepare('UPDATE runs SET state=?,result=?,error=?,ended_at=? WHERE id=?')
        .run(state, redact(result), redact(error), Date.now(), id)
      const key = this.run(id)!.conversation_key
      this.state(key, this.nextConversationState(key, state))
      this.db.prepare('UPDATE conversations SET updated_at=? WHERE key=?').run(Date.now(), key)
      acknowledge?.()
    })
  }

  private nextConversationState(key: string, finished: FinalRunState): ConversationState {
    if (this.hasRunIn(key, ['running'])) return 'running'
    if (finished === 'interrupted' || finished === 'waiting_human') return finished
    return this.hasQueued(key) ? 'queued' : 'idle'
  }

  setTranscript(id: string, transcript: string): void {
    this.db.prepare('UPDATE runs SET transcript=? WHERE id=?').run(transcript, id)
  }

  event(id: string, kind: string, data: unknown): void {
    const retained = isToolEvent(kind, data) ? retainedToolEvent(kind, data) : data
    this.db
      .prepare('INSERT INTO events(run_id,kind,data,created_at) VALUES(?,?,?,?)')
      .run(id, kind, JSON.stringify(redactDeep(retained)), Date.now())
  }

  recordUsage(id: string, cost: number, tokens: unknown): void {
    if (!Number.isFinite(cost) || cost < 0) throw new Error('Costo invalido en result de Claude.')
    this.transaction(() => {
      this.db
        .prepare('INSERT OR REPLACE INTO usage VALUES(?,?,?,?,?)')
        .run(id, this.run(id)!.author, today(), cost, JSON.stringify(tokens))
      this.db.prepare('UPDATE runs SET cost=? WHERE id=?').run(cost, id)
    })
  }

  // Human gates

  askGate(key: string, question: GateQuestion, destination: Conversation): void {
    this.db
      .prepare(
        "INSERT INTO gates(conversation_key,question,state,question_id,options,destination) VALUES(?,?,'pending',?,?,?) ON CONFLICT(conversation_key) DO UPDATE SET question=excluded.question,state='pending',answer=NULL,question_id=excluded.question_id,options=excluded.options,destination=excluded.destination",
      )
      .run(
        key,
        question.text,
        question.id,
        JSON.stringify(question.options),
        JSON.stringify(destination),
      )
  }

  gate(
    questionId: string,
  ):
    | { question: string; state: string; options: string[]; destination: Conversation | null }
    | undefined {
    const row = this.db.prepare('SELECT * FROM gates WHERE question_id=?').get(questionId)
    if (!row) return undefined

    return {
      question: row.question as string,
      state: row.state as string,
      options: JSON.parse(row.options as string),
      destination: row.destination ? JSON.parse(row.destination as string) : null,
    }
  }

  pendingQuestion(key: string): { text: string; options: string[] } | undefined {
    const row = this.db
      .prepare("SELECT question,options FROM gates WHERE conversation_key=? AND state='pending'")
      .get(key)

    return row
      ? { text: row.question as string, options: JSON.parse(row.options as string) }
      : undefined
  }

  private answerGate(key: string, answer: string): void {
    this.db
      .prepare(
        "UPDATE gates SET state='answered',answer=? WHERE conversation_key=? AND state='pending'",
      )
      .run(redact(answer), key)
  }

  // Restart

  recover(adapter?: AdapterFilter): Conversation[] {
    const adapters = adapterList(adapter)

    return this.transaction(() => {
      const affected = this.db
        .prepare(
          "SELECT DISTINCT c.* FROM conversations c JOIN runs r ON c.key=r.conversation_key WHERE r.state='running' AND (? IS NULL OR c.adapter IN (SELECT value FROM json_each(?)))",
        )
        .all(adapters, adapters) as unknown as Conversation[]

      for (const c of affected) {
        const run = this.db
          .prepare(
            "SELECT reply_thread FROM runs WHERE conversation_key=? AND state='running' LIMIT 1",
          )
          .get(c.key)

        if (!c.thread) c.thread = run?.reply_thread as string | null
        this.db
          .prepare(
            "UPDATE runs SET state='interrupted',error='Servidor reiniciado',ended_at=? WHERE conversation_key=? AND state='running'",
          )
          .run(Date.now(), c.key)
        this.state(c.key, 'interrupted')
      }

      return affected
    })
  }

  close(): void {
    if (this.ownsRuntime) this.db.prepare('DELETE FROM runtime WHERE owner=?').run(this.owner)
    this.db.close()
  }

  private hasRunIn(key: string, states: RunState[]): boolean {
    return Boolean(
      this.db
        .prepare(
          'SELECT 1 FROM runs WHERE conversation_key=? AND state IN (SELECT value FROM json_each(?))',
        )
        .get(key, JSON.stringify(states)),
    )
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** A room keeps its session even when its stable key originated in a DM. */
function sessionExpired(
  conversation: Conversation,
  input: Inbound,
  now: number,
  idleHours: number,
): boolean {
  const resettable =
    input.adapter === 'cli' ||
    (conversation.channel.startsWith('D') && /^slack:D[^:]*$/.test(input.key))

  return (
    conversation.state === 'idle' &&
    !input.thread &&
    resettable &&
    now - conversation.updated_at > idleHours * 3600000
  )
}

function isToolEvent(kind: string, data: unknown): data is Record<string, unknown> {
  return (
    (kind === 'tool_use' || kind === 'tool_result') && Boolean(data) && typeof data === 'object'
  )
}

/** Tool events keep their identity and outcome; inputs and outputs never reach the log. */
function retainedToolEvent(kind: string, event: Record<string, unknown>) {
  const input = event.input as Record<string, unknown> | undefined

  return {
    kind,
    id: event.id,
    parentId: event.parentId,
    name: event.name,
    error: event.error,
    background: event.background,
    ...(event.name === 'Bash'
      ? { input: { command: commandDisplay(input?.command)?.command } }
      : {}),
  }
}
