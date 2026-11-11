import type { HistoryMessage, HistorySource } from '../../core/history.ts'
import type { SlackApi } from './api.ts'
import { attachmentReference, fileName } from './attachments.ts'
import { imageReference } from './images.ts'
import { appLabel, messageBody, threadToMarkdown } from './thread.ts'

type ReadFile = (file: any) => Promise<string> | string

/** Slack timestamps ("1700000000.123456") as integers that sort and compare exactly. */
function slackTimestamp(ts: string): bigint {
  const [seconds, fraction = ''] = ts.split('.')
  return BigInt(seconds) * 1000000n + BigInt(fraction.padEnd(6, '0'))
}

/** Pages through a channel or thread, guarding against the API looping or truncating. */
async function* pageMessages(
  api: SlackApi,
  source: HistorySource,
  thread: string | undefined,
  signal?: AbortSignal,
): AsyncGenerator<any> {
  let cursor: string | undefined
  const cursors = new Set<string>()

  do {
    signal?.throwIfAborted()
    const result = await api(thread ? 'conversations.replies' : 'conversations.history', {
      channel: source.channel,
      ...(thread ? { ts: thread } : {}),
      latest: source.latest,
      inclusive: true,
      limit: 100,
      cursor,
    })

    for (const message of result.messages ?? []) {
      if (!message.ts) throw new Error('Slack devolvio un mensaje sin timestamp.')
      yield message
    }

    cursor = result.response_metadata?.next_cursor || undefined

    if (result.has_more && !cursor) {
      throw new Error('Slack devolvio historial incompleto sin cursor de continuacion.')
    }

    if (cursor && cursors.has(cursor)) throw new Error('Slack repitio el cursor de historial.')
    if (cursor) cursors.add(cursor)
  } while (cursor)
}

/** Every message up to `latest`, oldest first, with the replies of each channel root included. */
async function collectMessages(
  api: SlackApi,
  source: HistorySource,
  signal?: AbortSignal,
): Promise<any[]> {
  const messages = new Map<string, any>()
  const limit = source.latest ? slackTimestamp(source.latest) : undefined

  const collect = async (thread?: string) => {
    for await (const message of pageMessages(api, source, thread, signal)) {
      if (limit === undefined || slackTimestamp(message.ts) <= limit) {
        messages.set(message.ts, message)
      }
    }
  }

  await collect(source.thread)

  if (!source.thread) {
    // Old channel roots may have fresh replies, so do not advance only a channel timestamp.
    for (const message of [...messages.values()]) {
      if (message.reply_count) await collect(message.ts)
    }
  }

  return [...messages.values()].sort((a, b) => Number(slackTimestamp(a.ts) - slackTimestamp(b.ts)))
}

function authorLabel(message: any): string {
  const author = message.bot_id ? appLabel(message) : `@${message.user ?? 'unknown'}`
  const reply = message.thread_ts && message.thread_ts !== message.ts
  return reply ? `${author} (hilo ${message.thread_ts})` : author
}

/** The entries one message contributes: its text and one per attached image or file. */
async function historyEntries(
  message: any,
  channel: string,
  readFile: ReadFile,
): Promise<HistoryMessage[]> {
  const id = `${channel}:${message.ts}`
  const label = authorLabel(message)
  const entries: HistoryMessage[] = []
  const body = messageBody(message)
  if (body) entries.push({ id, text: `${label}: ${body}` })
  const files: any[] = message.files ?? []

  const described = await Promise.all(
    files.map(async (file, index): Promise<HistoryMessage> => {
      const image = imageReference(file)

      if (image) {
        return { id: `${id}:image:${image.id}`, text: `${label}: [imagen: ${image.name}]`, image }
      }

      const attachment = attachmentReference(file)

      return {
        id: `${id}:file:${attachment?.id ?? index}`,
        text: `${label}: ${await readFile(file)}`,
        ...(attachment ? { attachment } : {}),
      }
    }),
  )

  return [...entries, ...described]
}

export async function gatherHistory(
  api: SlackApi,
  source: HistorySource,
  botId: string,
  readFile: ReadFile,
  signal?: AbortSignal,
  includeOwn = false,
): Promise<HistoryMessage[]> {
  const result: HistoryMessage[] = []

  for (const message of await collectMessages(api, source, signal)) {
    signal?.throwIfAborted()
    if (!includeOwn && message.user === botId) continue
    if (message.subtype === 'message_deleted') continue
    result.push(...(await historyEntries(message, source.channel, readFile)))
  }

  return result
}

function sizeLabel(bytes: unknown): string | undefined {
  if (typeof bytes !== 'number' || bytes < 0) return
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * How one attached file is listed in the history. Its content never travels in the prompt:
 * the core downloads it and adds the server path the agent opens with its own tools.
 */
export function readSlackFile(file: any): string {
  const reference = attachmentReference(file)
  if (!reference) return `[attachment unavailable: ${fileName(file)}]`
  const summary = [reference.name, file.filetype, sizeLabel(file.size)].filter(Boolean).join(' · ')
  return `[attachment ${reference.id}: ${summary}]`
}

export async function gatherThread(
  api: SlackApi,
  channel: string,
  thread: string,
  readFile: ReadFile = readSlackFile,
): Promise<string> {
  const lines: string[] = []
  let cursor: string | undefined

  do {
    const result = await api('conversations.replies', { channel, ts: thread, limit: 100, cursor })

    for (const message of result.messages ?? []) {
      const author = message.bot_id ? appLabel(message) : `@${message.user ?? 'unknown'}`
      const files = (await Promise.all((message.files ?? []).map(readFile))).join('\n')
      const text = [messageBody(message), files].filter(Boolean).join('\n')
      if (text) lines.push(`${author}: ${text}`)
    }

    cursor = result.response_metadata?.next_cursor || undefined
  } while (cursor)

  return threadToMarkdown(lines.join('\n'))
}
