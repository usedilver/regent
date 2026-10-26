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

const REFERENCE_PREVIEW_CHARS = 200

type HashedMessage = HistoryMessage & { hash: string }

interface Packed {
  text: string
  omitted: number
  /** Ids whose full text made it into the prompt and can be acknowledged once delivered. */
  delivered: Set<string>
}

/** Resolves with the work, or rejects as soon as the signal aborts without waiting for it. */
async function abortable<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work()
  signal.throwIfAborted()
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })

  try {
    return await Promise.race([work(), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** One entry per message id, redacted, keeping only the fields the snapshot needs. */
function dedupe(messages: HistoryMessage[]): HistoryMessage[] {
  const byId = new Map<string, HistoryMessage>()

  for (const m of messages) {
    byId.set(m.id, { id: m.id, text: redact(m.text), ...(m.image ? { image: m.image } : {}) })
  }

  return [...byId.values()]
}

function hashOf(message: HistoryMessage): string {
  return createHash('sha256')
    .update(message.text + (message.image ? JSON.stringify(message.image) : ''))
    .digest('hex')
}

/**
 * Fits the newest messages into the prompt budget. Messages that do not fit are counted and
 * left as references, so the agent knows they exist without reading unacknowledged content.
 */
function pack(pending: HashedMessage[], trigger: string | undefined): Packed {
  const delivered = new Set<string>(trigger ? [trigger] : [])
  const parts: string[] = []
  let remaining = HISTORY_CONTEXT_CHARS
  let omitted = 0

  for (const message of [...pending].reverse()) {
    if (message.id === trigger) continue
    const text = `[${message.id}] ${message.text}`

    if (text.length + 2 <= remaining) {
      parts.unshift(text)
      delivered.add(message.id)
      remaining -= text.length + 2
      continue
    }

    omitted++
    const reference = `[${message.id}] Contenido no incluido; consulta regent_read_history. ${message.text.slice(0, REFERENCE_PREVIEW_CHARS)}`

    if (reference.length + 2 <= remaining) {
      parts.unshift(reference)
      remaining -= reference.length + 2
    }
  }

  const notice = omitted
    ? `Historial parcial: ${omitted} mensaje(s) pendiente(s) no se incluyeron completos. El historial de esta solicitud sigue disponible con regent_read_history (offset y max_chars). Consulta lo necesario antes de asumir requisitos.\n\n`
    : ''

  return { text: notice + parts.join('\n\n'), omitted, delivered }
}

/** Pending images, the trigger message's own first, as the image loader expects them. */
function pendingImages(pending: HashedMessage[], trigger: string | undefined) {
  const fromTrigger = (m: HistoryMessage) => Number(m.id.startsWith(`${trigger}:image:`))

  return pending
    .filter((m) => m.image)
    .reverse()
    .sort((a, b) => fromTrigger(b) - fromTrigger(a))
    .map((m) => ({ messageId: m.id, reference: m.image!, label: `[${m.id}] ${m.text}` }))
}

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

  /** The thread history this run should see, packed for the prompt, plus how to acknowledge it. */
  async prepare(
    runId: string,
    key: string,
    session: string | null,
    loader?: HistoryLoader,
    signal?: AbortSignal,
  ) {
    const row = this.store.db.prepare('SELECT * FROM run_history WHERE run_id=?').get(runId)

    if (!row) {
      return {
        text: '',
        images: [],
        omitted: 0,
        acknowledge(_sessionId: string, _skipped?: Set<string>) {},
      }
    }

    const source = JSON.parse(row.source as string) as HistorySource
    const messages: HistoryMessage[] =
      row.snapshot !== null
        ? JSON.parse(row.snapshot as string)
        : await this.snapshot(runId, source, loader, session, signal)
    const pending = this.unseen(messages, key, session)
    const packed = pack(pending, source.trigger)

    return {
      text: packed.text,
      omitted: packed.omitted,
      images: pendingImages(pending, source.trigger),
      acknowledge: (sessionId: string, skipped = new Set<string>()) =>
        this.acknowledge(key, sessionId, pending, packed.delivered, skipped),
    }
  }

  /** Loads the thread from Slack once and freezes it, so retries and re-reads see the same history. */
  private async snapshot(
    runId: string,
    source: HistorySource,
    loader: HistoryLoader | undefined,
    session: string | null,
    signal?: AbortSignal,
  ): Promise<HistoryMessage[]> {
    if (!loader) throw new HistoryUnavailable('No hay lector de historial Slack disponible.')
    let loaded: HistoryMessage[]

    try {
      loaded = await abortable(() => loader(source, signal, !session), signal)
    } catch (error) {
      signal?.throwIfAborted()
      throw new HistoryUnavailable(error)
    }

    signal?.throwIfAborted()
    const messages = dedupe(loaded)
    this.store.db
      .prepare('UPDATE run_history SET snapshot=? WHERE run_id=?')
      .run(JSON.stringify(messages), runId)
    return messages
  }

  /** Messages this CLI session has not been shown yet, or every message for a fresh session. */
  private unseen(messages: HistoryMessage[], key: string, session: string | null): HashedMessage[] {
    const seen = this.store.db.prepare(
      'SELECT 1 FROM history_seen WHERE conversation_key=? AND session_id=? AND message_id=? AND hash=?',
    )

    return messages
      .map((message) => ({ ...message, hash: hashOf(message) }))
      .filter((message) => !session || !seen.get(key, session, message.id, message.hash))
  }

  private acknowledge(
    key: string,
    sessionId: string,
    pending: HashedMessage[],
    delivered: Set<string>,
    skipped: Set<string>,
  ): void {
    const mark = this.store.db.prepare(
      'INSERT INTO history_seen VALUES(?,?,?,?) ON CONFLICT(conversation_key,session_id,message_id) DO UPDATE SET hash=excluded.hash',
    )

    for (const m of pending) {
      if (delivered.has(m.id) && !skipped.has(m.id)) mark.run(key, sessionId, m.id, m.hash)
    }
  }
}
