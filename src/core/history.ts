import { createHash } from 'node:crypto'
import { HistoryUnavailable } from '../execution/failures.ts'
import type { Store } from '../storage/store.ts'
import { redact } from '../storage/redact.ts'
import type { ImageReference } from './images.ts'

export interface HistorySource {
  channel: string
  thread?: string
  latest?: string
  trigger?: string
}
export interface HistoryMessage {
  id: string
  text: string
  image?: ImageReference
}
export type HistoryLoader = (
  source: HistorySource,
  signal?: AbortSignal,
  includeOwn?: boolean,
) => Promise<HistoryMessage[]>

// Packing budget for one prompt, not a limit on the Slack conversation or Claude's token window.
export const HISTORY_CONTEXT_CHARS = 60000

export class History {
  store: Store
  constructor(store: Store) {
    this.store = store
  }
  read(runId: string, offset: number, maxChars: number) {
    const row = this.store.db
      .prepare('SELECT source,snapshot FROM run_history WHERE run_id=?')
      .get(runId)
    const messages: HistoryMessage[] = row?.snapshot ? JSON.parse(row.snapshot as string) : []
    const text = messages.map((message) => `[${message.id}] ${redact(message.text)}`).join('\n\n')
    const end = Math.min(offset + maxChars, text.length)
    return {
      source: row ? JSON.parse(row.source as string) : null,
      text: text.slice(offset, end),
      total_characters: text.length,
      next_offset: end < text.length ? end : null,
    }
  }
  async prepare(
    runId: string,
    key: string,
    session: string | null,
    loader?: HistoryLoader,
    signal?: AbortSignal,
  ) {
    const row = this.store.db.prepare('SELECT * FROM run_history WHERE run_id=?').get(runId)
    if (!row)
      return {
        text: '',
        images: [],
        omitted: 0,
        acknowledge(_sessionId: string, _skipped?: Set<string>) {},
      }
    const source = JSON.parse(row.source as string) as HistorySource
    let messages: HistoryMessage[]
    if (row.snapshot !== null) messages = JSON.parse(row.snapshot as string)
    else {
      if (!loader) throw new HistoryUnavailable('No hay lector de historial Slack disponible.')
      try {
        signal?.throwIfAborted()
        let onAbort: (() => void) | undefined
        try {
          const aborted = signal
            ? new Promise<never>((_, reject) => {
                onAbort = () => reject(signal.reason)
                signal.addEventListener('abort', onAbort, { once: true })
              })
            : undefined
          const loading = loader(source, signal, !session)
          messages = aborted ? await Promise.race([loading, aborted]) : await loading
        } finally {
          if (onAbort) signal!.removeEventListener('abort', onAbort)
        }
      } catch (error) {
        signal?.throwIfAborted()
        throw new HistoryUnavailable(error)
      }
      signal?.throwIfAborted()
      messages = [
        ...new Map(
          messages.map((m) => [
            m.id,
            { id: m.id, text: redact(m.text), ...(m.image ? { image: m.image } : {}) },
          ]),
        ).values(),
      ]
      this.store.db
        .prepare('UPDATE run_history SET snapshot=? WHERE run_id=?')
        .run(JSON.stringify(messages), runId)
    }
    const seen = this.store.db.prepare(
      'SELECT 1 FROM history_seen WHERE conversation_key=? AND session_id=? AND message_id=? AND hash=?',
    )
    const pending = messages
      .map((message) => ({
        ...message,
        hash: createHash('sha256')
          .update(message.text + (message.image ? JSON.stringify(message.image) : ''))
          .digest('hex'),
      }))
      .filter((message) => !session || !seen.get(key, session, message.id, message.hash))
    const delivered = new Set<string>(source.trigger ? [source.trigger] : [])
    const parts: string[] = []
    let remaining = HISTORY_CONTEXT_CHARS
    let omitted = 0
    for (const message of [...pending].reverse()) {
      if (message.id === source.trigger) continue
      const text = `[${message.id}] ${message.text}`
      if (text.length + 2 <= remaining) {
        parts.unshift(text)
        delivered.add(message.id)
        remaining -= text.length + 2
        continue
      }
      omitted++
      // A reference surfaces large messages without acknowledging unread contents.
      const reference = `[${message.id}] Contenido no incluido; consulta regent_read_history. ${message.text.slice(0, 200)}`
      if (reference.length + 2 <= remaining) {
        parts.unshift(reference)
        remaining -= reference.length + 2
      }
    }
    return {
      text:
        (omitted
          ? `Historial parcial: ${omitted} mensaje(s) pendiente(s) no se incluyeron completos. El historial de esta solicitud sigue disponible con regent_read_history (offset y max_chars). Consulta lo necesario antes de asumir requisitos.\n\n`
          : '') + parts.join('\n\n'),
      omitted,
      images: pending
        .filter((m) => m.image)
        .reverse()
        .sort(
          (a, b) =>
            Number(b.id.startsWith(`${source.trigger}:image:`)) -
            Number(a.id.startsWith(`${source.trigger}:image:`)),
        )
        .map((m) => ({ messageId: m.id, reference: m.image!, label: `[${m.id}] ${m.text}` })),
      acknowledge: (sessionId: string, skipped = new Set<string>()) => {
        for (const m of pending)
          if (delivered.has(m.id) && !skipped.has(m.id))
            this.store.db
              .prepare(
                'INSERT INTO history_seen VALUES(?,?,?,?) ON CONFLICT(conversation_key,session_id,message_id) DO UPDATE SET hash=excluded.hash',
              )
              .run(key, sessionId, m.id, m.hash)
      },
    }
  }
}
