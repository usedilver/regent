import type { Conversation, Output, Run } from './types.ts'
import { Store, redact, redactDeep } from './store.ts'

const MAX_ATTEMPTS = 25

// Slack errors that reflect the payload, not a transient outage: the same delivery can never
// succeed, so retrying it forever only burns rate-limit budget. Dead-letter these on sight.
const PERMANENT_SLACK_ERRORS = new Set([
  'msg_too_long', 'invalid_blocks', 'invalid_block', 'unsupported_block_type', 'block_mismatch',
  'invalid_arguments', 'invalid_arg_name', 'cannot_update_message', 'edit_window_closed',
  'message_not_found', 'channel_not_found', 'not_in_channel', 'is_archived',
  'restricted_action', 'restricted_action_read_only',
])

function isPermanent(error: unknown): boolean {
  if (error instanceof SyntaxError) return true
  const code = (error as { data?: { error?: string } })?.data?.error
  if (typeof code === 'string' && PERMANENT_SLACK_ERRORS.has(code)) return true
  const message = (error as Error)?.message ?? ''
  return [...PERMANENT_SLACK_ERRORS].some(known => message.includes(known))
}

/** Persist visible outcomes before delivery; retries survive Socket Mode outages. */
export class DurableOutput implements Output {
  store: Store; delegate: Output
  inflight = new Map<string, Promise<void>>()
  timer?: NodeJS.Timeout
  closing?: Promise<void>
  constructor(store: Store, delegate: Output) { this.store = store; this.delegate = delegate }
  animates(c: Conversation): boolean { return this.delegate.animates?.(c) ?? false }
  activity(c: Conversation, run: Run, event: import('./runner.ts').RunnerEvent) { this.delegate.activity?.(c, run, event) }
  start(): void {
    this.timer = setInterval(() => { void this.flush() }, 5000)
    void this.flush()
  }
  async flush(): Promise<void> {
    const keys = this.store.db.prepare("SELECT DISTINCT conversation_key FROM deliveries WHERE state='pending'").all()
    for (const row of keys) await this.flushKey(row.conversation_key as string).catch(() => {})
    await this.recoverProgress()
  }
  flushKey(key: string): Promise<void> {
    const previous = this.inflight.get(key) ?? Promise.resolve()
    const work = previous.catch(() => {}).then(async () => {
      const rows = this.store.db.prepare("SELECT * FROM deliveries WHERE conversation_key=? AND state='pending' ORDER BY id").all(key)
      for (const row of rows) {
        let args: unknown[]
        try { args = JSON.parse(row.args as string) }
        catch (error) { this.deadLetter(row, error); continue }
        try {
          await this.deliver(row.kind as string, args)
          this.store.db.prepare("UPDATE deliveries SET state='sent',attempts=attempts+1,error=NULL WHERE id=?").run(row.id)
        } catch (error) {
          // Permanent or exhausted: dead-letter and keep going, so one poison delivery never
          // blocks the rest of the conversation's queue. Transient: record and retry next tick.
          if (isPermanent(error) || (row.attempts as number) + 1 >= MAX_ATTEMPTS) { this.deadLetter(row, error, args); continue }
          this.store.db.prepare('UPDATE deliveries SET attempts=attempts+1,error=? WHERE id=?').run(redact((error as Error).message), row.id)
          throw error
        }
      }
    }).finally(() => { if (this.inflight.get(key) === work) this.inflight.delete(key) })
    this.inflight.set(key, work)
    return work
  }
  async deliver(kind: string, args: any): Promise<void> {
    if (kind === 'notice') return void await this.delegate.notice(args[0], args[1])

    if (kind === 'status') return void await this.delegate.status(args[0], args[1])

    if (kind === 'question') {
      const current = this.store.db.prepare('SELECT state,destination FROM gates WHERE question_id=?').get(args[1].id)
      if (current?.state !== 'pending') return
      if (current.destination) args[0] = JSON.parse(current.destination as string)
      if (this.delegate.question) await this.delegate.question(args[0], args[1])
      else await this.delegate.notice(args[0], [args[1].text, ...args[1].options.map((o: string, i: number) => `${i + 1}. ${o}`)].join('\n'))
      return
    }

    if (kind === 'finish') return void await this.delegate.finish(args[0], args[1], args[2])

    throw new Error(`Tipo de entrega no soportado: ${kind}`)
  }
  /** Give up on a delivery that can never succeed: mark it failed, log it, and — for a finish —
   * tell the thread so the answer is not lost silently. Best-effort, never itself durable. */
  deadLetter(row: any, error: unknown, args?: unknown[]): void {
    const reason = redact((error as Error).message)
    this.store.db.prepare("UPDATE deliveries SET state='failed',attempts=attempts+1,error=? WHERE id=?").run(reason, row.id)
    console.error(`[delivery] entrega descartada ${row.kind} #${row.id} (${row.conversation_key}): ${reason}`)
    if (row.kind !== 'finish') return
    // Warn the thread even when the payload is unreadable: the conversation is keyed by column,
    // not by the corrupted args, so it is still reachable through the conversations table.
    const conversation = (args?.[0] as Conversation) ?? this.store.conversation(row.conversation_key)
    if (!conversation) return
    const detail = error instanceof SyntaxError ? 'su contenido quedo ilegible al guardarse' : `Slack la rechazo (${reason})`
    void Promise.resolve()
      .then(() => this.delegate.notice(conversation, `No pude entregar mi respuesta final: ${detail}. Pidemela de nuevo y la reenvio.`))
      .catch(() => {})
  }
  enqueue(kind: string, args: unknown[], key: string): Promise<void> {
    this.store.db.prepare('INSERT INTO deliveries(conversation_key,kind,args) VALUES(?,?,?)').run(key, kind, JSON.stringify(redactDeep(args)))
    return this.flushKey(key)
  }
  notice(c: Conversation, text: string) { return this.enqueue('notice', [c, text], c.key) }
  status(c: Conversation, status: 'processing' | 'active' | 'suspended') { return this.enqueue('status', [c, status], c.key) }
  delta(c: Conversation, run: Run, text: string) { return this.delegate.delta(c, run, text) }
  // Progress is an ephemeral, self-updating heartbeat: deliver best-effort, never persist/retry.
  progress(c: Conversation, run: Run, text: string) { return this.delegate.progress?.(c, run, text) ?? Promise.resolve() }
  recoverProgress() { return this.delegate.recoverProgress?.() ?? Promise.resolve() }
  finish(c: Conversation, run: Run, text: string) { return this.enqueue('finish', [c, run, text], c.key) }
  question(c: Conversation, question: { id: string; text: string; options: string[] }) { return this.enqueue('question', [c, question], c.key) }
  moved(run: Run) { return this.delegate.moved?.(run) ?? Promise.resolve() }
  close(): Promise<void> {
    if (this.closing) return this.closing
    clearInterval(this.timer)
    this.closing = (async () => {
      await Promise.allSettled(this.inflight.values())
      await this.recoverProgress()
    })()
    return this.closing
  }
}
