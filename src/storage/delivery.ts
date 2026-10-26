import type { Conversation, Output, Run } from '../core/types.ts'
import type { RunnerEvent } from '../execution/runner.ts'
import { Store } from './store.ts'
import { redact, redactDeep } from './redact.ts'

const MAX_ATTEMPTS = 25

// Slack errors that reflect the payload, not a transient outage: the same delivery can never
// succeed, so retrying it forever only burns rate-limit budget. Dead-letter these on sight.
const PERMANENT_SLACK_ERRORS = new Set([
  'msg_too_long',
  'invalid_blocks',
  'invalid_block',
  'unsupported_block_type',
  'block_mismatch',
  'invalid_arguments',
  'invalid_arg_name',
  'cannot_update_message',
  'edit_window_closed',
  'message_not_found',
  'channel_not_found',
  'not_in_channel',
  'is_archived',
  'restricted_action',
  'restricted_action_read_only',
])

function isPermanent(error: unknown): boolean {
  if (error instanceof SyntaxError) return true
  const code = (error as { data?: { error?: string } })?.data?.error
  if (typeof code === 'string' && PERMANENT_SLACK_ERRORS.has(code)) return true
  const message = (error as Error)?.message ?? ''
  return [...PERMANENT_SLACK_ERRORS].some((known) => message.includes(known))
}

/** Persist visible outcomes before delivery; retries survive Socket Mode outages. */
export class DurableOutput implements Output {
  store: Store
  delegate: Output
  inflight = new Map<string, Promise<void>>()
  timer?: NodeJS.Timeout
  closing?: Promise<void>

  constructor(store: Store, delegate: Output) {
    this.store = store
    this.delegate = delegate
  }

  animates(c: Conversation): boolean {
    return this.delegate.animates?.(c) ?? false
  }

  activity(c: Conversation, run: Run, event: RunnerEvent) {
    this.delegate.activity?.(c, run, event)
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.flush()
    }, 5000)
    void this.flush()
  }

  async flush(): Promise<void> {
    const keys = this.store.db
      .prepare("SELECT DISTINCT conversation_key FROM deliveries WHERE state='pending'")
      .all()

    for (const row of keys) await this.flushKey(row.conversation_key as string).catch(() => {})
    await this.recoverProgress()
  }

  /** Delivers a conversation's pending rows in order; one key never runs twice at once. */
  flushKey(key: string): Promise<void> {
    const previous = this.inflight.get(key) ?? Promise.resolve()
    const work = previous
      .catch(() => {})
      .then(async () => {
        const rows = this.store.db
          .prepare(
            "SELECT * FROM deliveries WHERE conversation_key=? AND state='pending' ORDER BY id",
          )
          .all(key)

        for (const row of rows) await this.deliverRow(row)
      })
      .finally(() => {
        if (this.inflight.get(key) === work) this.inflight.delete(key)
      })

    this.inflight.set(key, work)
    return work
  }

  /** Throws on a transient failure so the rest of the queue waits for the next tick. */
  private async deliverRow(row: any): Promise<void> {
    let args: unknown[]

    try {
      args = JSON.parse(row.args as string)
    } catch (error) {
      return this.deadLetter(row, error)
    }

    try {
      await this.deliver(row.kind as string, args)
      this.store.db
        .prepare("UPDATE deliveries SET state='sent',attempts=attempts+1,error=NULL WHERE id=?")
        .run(row.id)
    } catch (error) {
      // Permanent or exhausted: dead-letter and keep going, so one poison delivery never
      // blocks the rest of the conversation's queue. Transient: record and retry next tick.
      if (isPermanent(error) || (row.attempts as number) + 1 >= MAX_ATTEMPTS) {
        return this.deadLetter(row, error, args)
      }

      this.store.db
        .prepare('UPDATE deliveries SET attempts=attempts+1,error=? WHERE id=?')
        .run(redact((error as Error).message), row.id)
      throw error
    }
  }

  async deliver(kind: string, args: any): Promise<void> {
    switch (kind) {
      case 'notice':
        return void (await this.delegate.notice(args[0], args[1]))
      case 'status':
        return void (await this.delegate.status(args[0], args[1]))
      case 'question':
        return this.deliverQuestion(args)
      case 'finish':
        return void (await this.delegate.finish(args[0], args[1], args[2]))
      default:
        throw new Error(`Tipo de entrega no soportado: ${kind}`)
    }
  }

  /** A question still pending is asked where the conversation lives now, not where it was queued. */
  private async deliverQuestion(args: any): Promise<void> {
    const gate = this.store.gate(args[1].id)
    if (gate?.state !== 'pending') return
    const conversation = gate.destination ?? args[0]

    if (this.delegate.question) {
      await this.delegate.question(conversation, args[1])
      return
    }

    const numbered = args[1].options.map((o: string, i: number) => `${i + 1}. ${o}`)
    await this.delegate.notice(conversation, [args[1].text, ...numbered].join('\n'))
  }

  /** Give up on a delivery that can never succeed: mark it failed, log it and, for a finish,
   * tell the thread so the answer is not lost silently. Best effort, never itself durable. */
  deadLetter(row: any, error: unknown, args?: unknown[]): void {
    const reason = redact((error as Error).message)
    this.store.db
      .prepare("UPDATE deliveries SET state='failed',attempts=attempts+1,error=? WHERE id=?")
      .run(reason, row.id)
    console.error(
      `[delivery] entrega descartada ${row.kind} #${row.id} (${row.conversation_key}): ${reason}`,
    )
    if (row.kind !== 'finish') return
    // Warn the thread even when the payload is unreadable: the conversation is keyed by column,
    // not by the corrupted args, so it is still reachable through the conversations table.
    const conversation =
      (args?.[0] as Conversation) ?? this.store.conversation(row.conversation_key)

    if (!conversation) return
    const detail =
      error instanceof SyntaxError
        ? 'su contenido quedo ilegible al guardarse'
        : `Slack la rechazo (${reason})`

    void Promise.resolve()
      .then(() =>
        this.delegate.notice(
          conversation,
          `No pude entregar mi respuesta final: ${detail}. Pidemela de nuevo y la reenvio.`,
        ),
      )
      .catch(() => {})
  }

  enqueue(kind: string, args: unknown[], key: string): Promise<void> {
    this.store.db
      .prepare('INSERT INTO deliveries(conversation_key,kind,args) VALUES(?,?,?)')
      .run(key, kind, JSON.stringify(redactDeep(args)))
    return this.flushKey(key)
  }

  notice(c: Conversation, text: string) {
    return this.enqueue('notice', [c, text], c.key)
  }

  status(c: Conversation, status: 'processing' | 'active' | 'suspended') {
    return this.enqueue('status', [c, status], c.key)
  }

  delta(c: Conversation, run: Run, text: string) {
    return this.delegate.delta(c, run, text)
  }

  // Progress is an ephemeral, self-updating heartbeat: deliver best-effort, never persist/retry.
  progress(c: Conversation, run: Run, text: string) {
    return this.delegate.progress?.(c, run, text) ?? Promise.resolve()
  }

  recoverProgress() {
    return this.delegate.recoverProgress?.() ?? Promise.resolve()
  }

  finish(c: Conversation, run: Run, text: string) {
    return this.enqueue('finish', [c, run, text], c.key)
  }

  question(c: Conversation, question: { id: string; text: string; options: string[] }) {
    return this.enqueue('question', [c, question], c.key)
  }

  moved(run: Run) {
    return this.delegate.moved?.(run) ?? Promise.resolve()
  }

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
