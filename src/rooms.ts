import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Store, redact } from './store.ts'
import type { Conversation, Rooms } from './types.ts'

export const RoomRequest = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/),
  summary: z.string().min(1).max(10000),
  users: z.array(z.string().regex(/^[UW][A-Z0-9]+$/)).max(20).default([]),
})
export interface RoomTransfer {
  conversation_key: string; name: string; channel: string | null; origin: string
  summary: string; users: string; state: string
}

export class RoomTransfers {
  store: Store
  constructor(store: Store) { this.store = store }
  get(key: string) { return this.store.db.prepare('SELECT * FROM room_transfers WHERE conversation_key=?').get(key) as unknown as RoomTransfer | undefined }
  move(key: string, channel: string): void {
    this.store.transaction(() => {
      const transfer = this.get(key)
      if (!transfer || transfer.channel !== channel) throw new Error('La sala no esta preparada para esta conversacion.')
      if (transfer.state === 'moved') return
      const origin = JSON.parse(transfer.origin) as Conversation
      const destination = { ...this.store.conversation(key)!, channel, thread: null }
      this.store.db.prepare('UPDATE conversations SET channel=?, thread=NULL WHERE key=?').run(channel, key)
      this.store.db.prepare('INSERT INTO conversation_history VALUES(?,?) ON CONFLICT(conversation_key) DO UPDATE SET source=excluded.source').run(key, JSON.stringify({ channel }))
      this.store.db.prepare("UPDATE runs SET reply_channel=?, reply_thread=NULL WHERE conversation_key=? AND state IN ('queued','running')").run(channel, key)
      this.store.db.prepare("UPDATE room_transfers SET state='moved' WHERE conversation_key=?").run(key)
      const enqueue = (kind: string, args: unknown[]) => this.store.db.prepare('INSERT INTO deliveries(conversation_key,kind,args) VALUES(?,?,?)').run(key, kind, redact(JSON.stringify(args)))
      enqueue('notice', [origin, `Continuamos en <#${channel}>.`])
      enqueue('status', [origin, 'active'])
      enqueue('notice', [destination, `Continuamos esta conversacion aqui.\n${transfer.summary}`])
      enqueue('status', [destination, 'processing'])
      const question = this.store.db.prepare("SELECT * FROM gates WHERE conversation_key=? AND state='pending'").get(key)
      if (question?.question_id) {
        this.store.db.prepare('UPDATE gates SET destination=? WHERE conversation_key=?').run(JSON.stringify(destination), key)
        const pending = this.store.db.prepare("SELECT args FROM deliveries WHERE conversation_key=? AND kind='question' AND state='pending'").all(key)
        if (!pending.some(row => JSON.parse(row.args as string)[1].id === question.question_id)) {
          enqueue('question', [destination, { id: question.question_id, text: question.question, options: JSON.parse(question.options as string) }])
        }
      }
    })
  }
  async prepare(c: Conversation, input: unknown, api: Rooms, signal: AbortSignal): Promise<RoomTransfer> {
    const args = RoomRequest.parse(input)
    const previous = this.get(c.key)
    const users = [...new Set([...(previous ? JSON.parse(previous.users) : []), c.author, ...args.users])] as string[]
    for (const user of users) { signal.throwIfAborted(); await api.validateUser(user) }
    signal.throwIfAborted()
    if (!previous) this.store.db.prepare('INSERT INTO room_transfers(conversation_key,name,origin,summary,users) VALUES(?,?,?,?,?)')
      .run(c.key, `${args.name}-${randomUUID().replaceAll('-', '').slice(0, 12)}`, JSON.stringify(c), redact(args.summary), JSON.stringify(users))
    else this.store.db.prepare('UPDATE room_transfers SET users=? WHERE conversation_key=?').run(JSON.stringify(users), c.key)
    let row = this.get(c.key)!
    if (!row.channel) {
      // A stable, persisted name lets Slack enforce uniqueness even after a lost create response.
      const existing = await api.find(row.name)
      signal.throwIfAborted()
      const channel = existing ?? await api.create(row.name)
      this.store.db.prepare('UPDATE room_transfers SET channel=? WHERE conversation_key=?').run(channel, c.key)
      row = this.get(c.key)!
    }
    for (const user of users) { signal.throwIfAborted(); await api.invite(row.channel!, user) }
    signal.throwIfAborted()
    return row
  }
}
