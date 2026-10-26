import type { HistoryMessage, HistorySource } from '../../core/history.ts'
import type { SlackApi } from './api.ts'
import { imageReference } from './images.ts'
import { appLabel, messageBody, threadToMarkdown } from './thread.ts'

type ReadFile = (file: any) => Promise<string>

const FILE_BYTES = 200 * 1024
const FILE_CHARS = 12000
const TEXT_FILETYPES = /^(log|txt|json|yaml|yml|md|csv|diff|patch|xml)$/i

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

/** The entries one message contributes: its text, one per image, and its other files together. */
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
  const otherFiles: any[] = []

  for (const file of message.files ?? []) {
    const image = imageReference(file)

    if (image) {
      entries.push({
        id: `${id}:image:${image.id}`,
        text: `${label}: [imagen: ${image.name}]`,
        image,
      })
    } else {
      otherFiles.push(file)
    }
  }

  const files = (await Promise.all(otherFiles.map(readFile))).join('\n')
  if (files) entries.push({ id: `${id}:files`, text: `${label}: ${files}` })
  return entries
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

function isTextFile(file: any): boolean {
  return (
    file.mode === 'snippet' ||
    /^text\//.test(file.mimetype ?? '') ||
    TEXT_FILETYPES.test(file.filetype ?? '')
  )
}

async function downloadText(url: URL, token: string, download: typeof fetch): Promise<string> {
  const response = await download(url, {
    headers: { authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  })

  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of response.body) {
    size += chunk.length
    if (size > FILE_BYTES) throw new Error('archivo mayor a 200 KB')
    chunks.push(Buffer.from(chunk))
  }

  return Buffer.concat(chunks).toString('utf8').slice(0, FILE_CHARS)
}

/** A text attachment as prompt context, or just its label when it cannot or should not be read. */
export async function readSlackFile(
  file: any,
  token: string,
  download: typeof fetch = fetch,
): Promise<string> {
  const label = `[archivo: ${file.title ?? file.name ?? file.id}]`

  if (!isTextFile(file) || !file.url_private_download || (file.size ?? 0) > FILE_BYTES) {
    return file.preview ? `${label}\n${file.preview}` : label
  }

  try {
    const url = new URL(file.url_private_download)

    if (url.protocol !== 'https:' || url.hostname !== 'files.slack.com') {
      return `${label} (URL de descarga no autorizada)`
    }

    return `${label}\n${await downloadText(url, token, download)}`
  } catch (error) {
    return `${label} (no pude leerlo: ${(error as Error).message})`
  }
}

export async function gatherThread(
  api: SlackApi,
  channel: string,
  thread: string,
  readFile: ReadFile = (file) => readSlackFile(file, ''),
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
