import { createHash } from 'node:crypto'
import type { Store } from './store.ts'
import { redact } from './store.ts'

export interface HistorySource { channel: string; thread?: string; latest?: string; trigger?: string }
export interface HistoryMessage { id: string; text: string }
export type HistoryLoader = (source: HistorySource, signal?: AbortSignal, includeOwn?: boolean) => Promise<HistoryMessage[]>

export class History {
  store: Store
  constructor(store: Store) { this.store = store }
  async prepare(runId: string, key: string, session: string | null, loader?: HistoryLoader, signal?: AbortSignal) {
    const row = this.store.db.prepare('SELECT * FROM run_history WHERE run_id=?').get(runId)
    if (!row) return { text: '', acknowledge() {} }
    const source = JSON.parse(row.source as string) as HistorySource
    let messages: HistoryMessage[]
    if (row.snapshot !== null) messages = JSON.parse(row.snapshot as string)
    else {
      if (!loader) throw new Error('No hay lector de historial Slack disponible.')
      messages = await loader(source, signal, !session)
      signal?.throwIfAborted()
      messages = [...new Map(messages.map(m => [m.id, { id: m.id, text: redact(m.text) }])).values()]
      if (messages.length > 2000 || JSON.stringify(messages).length > 200000) throw new Error('El historial excede el limite de contexto; usa un hilo mas acotado.')
      this.store.db.prepare('UPDATE run_history SET snapshot=? WHERE run_id=?').run(JSON.stringify(messages), runId)
    }
    const pending = messages.map(message => ({ ...message, hash: createHash('sha256').update(message.text).digest('hex') }))
      .filter(message => !session || !this.store.db.prepare('SELECT 1 FROM history_seen WHERE conversation_key=? AND session_id=? AND message_id=? AND hash=?').get(key, session, message.id, message.hash))
    return {
      text: pending.filter(m => m.id !== source.trigger).map(m => `[${m.id}] ${m.text}`).join('\n\n'),
      acknowledge: (sessionId: string) => {
        for (const m of pending) this.store.db.prepare('INSERT INTO history_seen VALUES(?,?,?,?) ON CONFLICT(conversation_key,session_id,message_id) DO UPDATE SET hash=excluded.hash').run(key, sessionId, m.id, m.hash)
      },
    }
  }
}
