import type { Conversation, Output, Run } from './types.ts'
import { Store, redact } from './store.ts'

/** Persist visible outcomes before delivery; retries survive Socket Mode outages. */
export class DurableOutput implements Output {
  store: Store; delegate: Output
  inflight = new Map<string, Promise<void>>()
  timer?: NodeJS.Timeout
  constructor(store: Store, delegate: Output) { this.store = store; this.delegate = delegate }
  start(): void {
    this.timer = setInterval(() => { void this.flush() }, 5000)
    void this.flush()
  }
  async flush(): Promise<void> {
    const keys = this.store.db.prepare("SELECT DISTINCT conversation_key FROM deliveries WHERE state='pending'").all()
    for (const row of keys) await this.flushKey(row.conversation_key as string).catch(() => {})
  }
  flushKey(key: string): Promise<void> {
    const previous = this.inflight.get(key) ?? Promise.resolve()
    const work = previous.catch(() => {}).then(async () => {
      const rows = this.store.db.prepare("SELECT * FROM deliveries WHERE conversation_key=? AND state='pending' ORDER BY id").all(key)
      for (const row of rows) {
        try {
          const args = JSON.parse(row.args as string)
          if (row.kind === 'notice') await this.delegate.notice(args[0], args[1])
          else if (row.kind === 'status') await this.delegate.status(args[0], args[1])
          else if (row.kind === 'gate') {
            if (this.delegate.gate) await this.delegate.gate(args[0], args[1], args[2])
            else await this.delegate.notice(args[0], `${args[2]}\nCompuerta: ${args[1].id}`)
          }
          else await this.delegate.finish(args[0], args[1], args[2])
          this.store.db.prepare("UPDATE deliveries SET state='sent',attempts=attempts+1,error=NULL WHERE id=?").run(row.id)
        } catch (error) {
          this.store.db.prepare('UPDATE deliveries SET attempts=attempts+1,error=? WHERE id=?').run(redact((error as Error).message), row.id)
          throw error
        }
      }
    }).finally(() => { if (this.inflight.get(key) === work) this.inflight.delete(key) })
    this.inflight.set(key, work)
    return work
  }
  enqueue(kind: string, args: unknown[], key: string): Promise<void> {
    this.store.db.prepare('INSERT INTO deliveries(conversation_key,kind,args) VALUES(?,?,?)').run(key, kind, redact(JSON.stringify(args)))
    return this.flushKey(key)
  }
  notice(c: Conversation, text: string) { return this.enqueue('notice', [c, text], c.key) }
  status(c: Conversation, status: 'processing' | 'active' | 'suspended') { return this.enqueue('status', [c, status], c.key) }
  delta(c: Conversation, run: Run, text: string) { return this.delegate.delta(c, run, text) }
  finish(c: Conversation, run: Run, text: string) { return this.enqueue('finish', [c, run, text], c.key) }
  gate(c: Conversation, gate: { id: string; kind: string; questions: string[] }, text: string) { return this.enqueue('gate', [c, gate, text], c.key) }
  async close(): Promise<void> { clearInterval(this.timer); await Promise.allSettled(this.inflight.values()) }
}
