import pkg from '@slack/bolt'
import { appLabel, messageBody, threadToMarkdown } from '../slack-thread.ts'
import type { Config } from './config.ts'
import type { Core } from './core.ts'
import type { Conversation, Output, Run } from './types.ts'
import { redact } from './store.ts'
import type { Rooms } from './types.ts'
import type { HistoryMessage, HistorySource } from './history.ts'

export async function gatherHistory(api: Api, source: HistorySource, botId: string, readFile: (file: any) => Promise<string>, signal?: AbortSignal, includeOwn = false): Promise<HistoryMessage[]> {
  const messages = new Map<string, any>()
  const stamp = (ts: string) => { const [seconds, fraction = ''] = ts.split('.'); return BigInt(seconds) * 1000000n + BigInt(fraction.padEnd(6, '0')) }
  const collect = async (thread?: string) => {
    let cursor: string | undefined
    const cursors = new Set<string>()
    do {
      signal?.throwIfAborted()
      const result = await api(thread ? 'conversations.replies' : 'conversations.history', {
        channel: source.channel, ...(thread ? { ts: thread } : {}), latest: source.latest, inclusive: true, limit: 100, cursor,
      })
      for (const message of result.messages ?? []) {
        if (!message.ts) throw new Error('Slack devolvio un mensaje sin timestamp.')
        if (!source.latest || stamp(message.ts) <= stamp(source.latest)) messages.set(message.ts, message)
      }
      if (messages.size > 2000) throw new Error('Historial Slack demasiado grande; usa un hilo mas acotado.')
      cursor = result.response_metadata?.next_cursor || undefined
      if (result.has_more && !cursor) throw new Error('Slack devolvio historial incompleto sin cursor de continuacion.')
      if (cursor && cursors.has(cursor)) throw new Error('Slack repitio el cursor de historial.')
      if (cursor) cursors.add(cursor)
    } while (cursor)
  }
  await collect(source.thread)
  if (!source.thread) {
    // Old channel roots may have fresh replies, so do not advance only a channel timestamp.
    for (const message of [...messages.values()]) if (message.reply_count) await collect(message.ts)
  }
  const result: HistoryMessage[] = []
  for (const m of [...messages.values()].sort((a, b) => stamp(a.ts) < stamp(b.ts) ? -1 : stamp(a.ts) > stamp(b.ts) ? 1 : 0)) {
    signal?.throwIfAborted()
    if ((!includeOwn && m.user === botId) || m.subtype === 'message_deleted') continue
    const id = `${source.channel}:${m.ts}`
    const author = m.bot_id ? appLabel(m) : `@${m.user ?? 'unknown'}`
    const label = `${author}${m.thread_ts && m.thread_ts !== m.ts ? ` (hilo ${m.thread_ts})` : ''}`
    const body = messageBody(m)
    if (body) result.push({ id, text: `${label}: ${body}` })
    const files = (await Promise.all((m.files ?? []).map(readFile))).join('\n')
    if (files) result.push({ id: `${id}:files`, text: `${label}: ${files}` })
  }
  return result
}

type Api = (method: string, args: Record<string, any>) => Promise<any>
type Stream = { ts?: string; pending: string; sent: string; timer?: NodeJS.Timeout; chain: Promise<void>; failed?: boolean; channel: string; thread?: string }

/**
 * Regla de invocacion (codigo, no criterio del modelo): en canales, hilos y salas el
 * bot solo actua con @mencion. Sin mencion se acepta unicamente al autor de la
 * conversacion cuando el bot le pidio algo (waiting_human/interrupted) o para los
 * comandos exactos de control. En DM todo se procesa: es un 1:1 con el bot.
 */
export function accepts(input: { dm: boolean; mention: boolean; author: string; text: string; conversation?: { author: string; state: string } | null }): boolean {
  if (input.dm || input.mention) return true
  const c = input.conversation
  if (!c || c.author !== input.author) return false
  if (['waiting_human', 'interrupted'].includes(c.state)) return true
  return ['stop', 'para', 'reset', 'nuevo'].includes(input.text.trim().toLowerCase())
}

export class SlackOutput implements Output {
  api: Api
  streams = new Map<string, Stream>()
  flushMs: number
  animates = true // Agent messaging shows the native "está trabajando…" indicator.
  constructor(api: Api, flushMs = 3000) { this.api = api; this.flushMs = flushMs }
  async question(c: Conversation, question: { id: string; text: string; options: string[] }): Promise<void> {
    if (!question.options.length) return this.notice(c, question.text)
    const options = question.options.map((o, i) => `${i + 1}. ${redact(o)}`).join('\n')
    await this.api('chat.postMessage', { channel: c.channel, thread_ts: c.thread ?? undefined,
      text: `${redact(question.text)}\n${options}`, unfurl_links: false, blocks: [
        { type: 'section', text: { type: 'plain_text', text: redact(question.text) } },
        { type: 'section', text: { type: 'plain_text', text: options } },
        { type: 'actions', elements: question.options.map((_, i) => ({ type: 'button',
          text: { type: 'plain_text', text: `Opcion ${i + 1}` }, action_id: `regent_question_${i}`, value: question.id })) },
      ] })
  }
  async notice(c: Conversation, text: string): Promise<void> {
    text = redact(text)
    for (let offset = 0; offset < text.length; offset += 3500) await this.api('chat.postMessage', { channel: c.channel, thread_ts: c.thread ?? undefined, text: text.slice(offset, offset + 3500), unfurl_links: false })
  }
  latestThread = new Map<string, string>()
  /** DMs anchor each response to its request; a room converses at channel root. */
  anchor(c: Conversation): string | undefined {
    return c.thread ?? (c.channel.startsWith('D') ? this.latestThread.get(c.key) : undefined)
  }
  async status(c: Conversation, status: 'processing' | 'active' | 'suspended'): Promise<void> {
    const thread = this.anchor(c)
    try { await this.api('agents.sessions.setStatus', { channel_id: c.channel, thread_ts: thread, status, initiator_user_id: c.author }) }
    catch (error) {
      // Native status needs an agent session; elsewhere only the ack matters — the final text covers the rest.
      console.error(`[slack v2] setStatus ${status}: ${redact((error as Error).message)}`)
      if (status === 'processing') await this.notice({ ...c, thread: thread ?? null }, 'Recibido; estoy en ello.')
    }
  }
  async delta(c: Conversation, run: Run, text: string): Promise<void> {
    let stream = this.streams.get(run.id)
    if (!stream) {
      stream = { pending: '', sent: '', chain: Promise.resolve(), channel: c.channel, thread: this.anchor(c) }
      this.streams.set(run.id, stream)
    }
    stream.pending += text
    if (!stream.timer) stream.timer = setTimeout(() => {
      stream!.timer = undefined
      stream!.chain = stream!.chain.then(() => this.flush(c, run, stream!)).catch(() => { stream!.failed = true })
    }, this.flushMs)
  }
  async flush(c: Conversation, run: Run, stream: Stream): Promise<void> {
    if (!stream.pending || stream.failed) return
    // Redact complete lines: token and key/value pairs can span many deltas.
    const end = stream.pending.lastIndexOf('\n', 11000) + 1
    if (!end) return
    const raw = stream.pending.slice(0, end)
    const text = redact(raw)
    if (!stream.ts) {
      const result = await this.api('chat.startStream', { channel: stream.channel, thread_ts: stream.thread, recipient_user_id: run.author, recipient_team_id: c.team, markdown_text: text })
      if (!result.ts) throw new Error('Slack no devolvio ts del stream.')
      stream.ts = result.ts
    } else await this.api('chat.appendStream', { channel: stream.channel, ts: stream.ts, markdown_text: text })
    stream.sent += text
    stream.pending = stream.pending.slice(raw.length)
  }
  async finish(c: Conversation, run: Run, text: string): Promise<void> {
    text = redact(text)
    const stream = this.streams.get(run.id)
    if (!stream) return this.notice({ ...c, thread: this.anchor(c) ?? null }, text)
    clearTimeout(stream.timer)
    await stream.chain
    try {
      if (stream.ts) {
        await this.api('chat.stopStream', { channel: stream.channel, ts: stream.ts })
        // The authoritative result can differ from interim assistant messages.
        if (text.length <= 3500) await this.api('chat.update', { channel: stream.channel, ts: stream.ts, text: redact(text) })
        else {
          await this.api('chat.update', { channel: stream.channel, ts: stream.ts, text: redact(text.slice(0, 3500)) })
          await this.notice({ ...c, channel: stream.channel, thread: stream.thread ?? null }, text.slice(3500))
        }
      } else await this.notice({ ...c, channel: stream.channel, thread: stream.thread ?? null }, text)
    } catch (error) {
      await this.notice({ ...c, channel: stream.channel, thread: stream.thread ?? null }, `${text}\n\nNo pude cerrar el stream: ${(error as Error).message}`)
    } finally { this.streams.delete(run.id) }
  }
  /** The conversation moved to its room: close the origin stream so the rest lands there. */
  async moved(run: Run): Promise<void> {
    const stream = this.streams.get(run.id)
    if (!stream) return
    this.streams.delete(run.id)
    clearTimeout(stream.timer)
    await stream.chain.catch(() => {})
    if (stream.failed || !stream.ts) return
    try {
      const tail = redact(stream.pending)
      if (tail.trim()) await this.api('chat.appendStream', { channel: stream.channel, ts: stream.ts, markdown_text: tail })
      await this.api('chat.stopStream', { channel: stream.channel, ts: stream.ts })
    } catch (error) { console.error(`[slack v2] cierre de stream al mover: ${redact((error as Error).message)}`) }
  }
}

export async function readSlackFile(file: any, token: string, download: typeof fetch = fetch): Promise<string> {
  const label = `[archivo: ${file.title ?? file.name ?? file.id}]`
  const textLike = file.mode === 'snippet' || /^text\//.test(file.mimetype ?? '') || /^(log|txt|json|yaml|yml|md|csv|diff|patch|xml)$/i.test(file.filetype ?? '')
  if (!textLike || !file.url_private_download || (file.size ?? 0) > 200 * 1024) return file.preview ? `${label}\n${file.preview}` : label
  try {
    const url = new URL(file.url_private_download)
    if (url.protocol !== 'https:' || url.hostname !== 'files.slack.com') return `${label} (URL de descarga no autorizada)`
    const response = await download(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(5000) })
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
    const chunks: Buffer[] = []; let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > 200 * 1024) throw new Error('archivo mayor a 200 KB')
      chunks.push(Buffer.from(chunk))
    }
    return `${label}\n${Buffer.concat(chunks).toString('utf8').slice(0, 12000)}`
  } catch (error) { return `${label} (no pude leerlo: ${(error as Error).message})` }
}

export async function gatherThread(api: Api, channel: string, thread: string, readFile: (file: any) => Promise<string> = file => readSlackFile(file, '')): Promise<string> {
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

export function createSlack(config: Config) {
  const app = new pkg.App({ token: process.env.SLACK_BOT_TOKEN, appToken: process.env.SLACK_APP_TOKEN, socketMode: true,
    clientOptions: { timeout: 2500, retryConfig: { retries: 2 } } })
  const api: Api = async (method, args) => {
    const response = await app.client.apiCall(method, args)
    if (!response.ok) throw new Error(`${method}: ${response.error}`)
    return response
  }
  const output = new SlackOutput(api)
  const rooms: Rooms = {
    async create(name, author, text) {
      const response = await api('conversations.create', { name, is_private: true })
      const channel = response.channel?.id
      if (!channel) throw new Error('Slack no devolvio la sala creada.')
      try { await api('conversations.invite', { channel, users: author }) }
      catch (error) { if (!(error as Error).message.includes('already_in_channel')) throw error }
      const message = await api('chat.postMessage', { channel, text: redact(text), unfurl_links: false })
      return { channel, thread: message.ts }
    },
    async find(name) {
      let cursor: string | undefined
      do {
        const response = await api('conversations.list', { types: 'private_channel', exclude_archived: true, limit: 200, cursor })
        const channel = response.channels?.find((c: any) => c.name === name && c.is_member)
        if (channel) {
          const history = await api('conversations.history', { channel: channel.id, limit: 100 })
          const root = history.messages?.findLast((m: any) => m.user === botId && !m.subtype)
          if (root) return { channel: channel.id, thread: root.ts }
          return undefined
        }
        cursor = response.response_metadata?.next_cursor || undefined
      } while (cursor)
      return undefined
    },
    async history(channel) {
      const lines: string[] = []
      let cursor: string | undefined
      do {
        const response = await api('conversations.history', { channel, limit: 100, cursor })
        for (const message of response.messages ?? []) {
          if (!message.bot_id && !message.subtype && message.user !== botId) lines.push(`@${message.user}: ${messageBody(message)}`)
          if (message.reply_count) {
            const replies = await gatherThread(api, channel, message.ts, file => readSlackFile(file, process.env.SLACK_BOT_TOKEN!))
            lines.push(replies)
          }
        }
        cursor = response.response_metadata?.next_cursor || undefined
      } while (cursor)
      return redact(lines.reverse().join('\n')).slice(0, 50000) || 'Sin mensajes adicionales.'
    },
    async archive(channel) {
      try { await api('conversations.archive', { channel }) }
      catch (error) { if (!(error as Error).message.includes('already_archived')) throw error }
    },
  }
  let core: Core, botId = '', connected = false
  const membership = new Map<string, { allowed: boolean; checkedAt: number }>()
  const receiver = app.receiver as any
  receiver.client.on('connected', () => { connected = true })
  receiver.client.on('disconnected', () => { connected = false })
  receiver.client.on('reconnecting', () => { connected = false })

  const handle = async (event: any, body: any, mention = false) => {
    if (event.bot_id || event.user === botId || (event.subtype && event.subtype !== 'file_share') || !event.user || !event.ts) return
    if (event.user_team && event.user_team !== config.slack.workspace_team_id) return
    const dm = event.channel_type === 'im' || event.channel.startsWith('D')
    const roomConversation = core.store.db.prepare("SELECT key FROM conversations WHERE adapter='slack' AND channel=? AND thread IS NULL").get(event.channel)
    const room = Boolean(roomConversation)
    // A room converses at channel root; elsewhere the thread anchors the conversation.
    const thread = dm ? undefined : room ? event.thread_ts : event.thread_ts ?? event.ts
    const key = roomConversation?.key as string ?? (dm ? `slack:${event.channel}` : `slack:${event.channel}:${event.thread_ts ?? event.ts}`)
    // app_mention and message may have different event IDs for the same message.
    if (!mention && !dm && (event.text ?? '').includes(`<@${botId}>`)) return
    const text = messageBody(event).replaceAll(`<@${botId}>`, '').trim()
    if (!accepts({ dm, mention, author: event.user, text, conversation: core.store.conversation(key) })) return
    const input = { adapter: 'slack' as const, eventId: `message:${event.channel}:${event.ts}`, key, channel: event.channel,
      thread, replyThread: event.thread_ts ?? (room ? undefined : event.ts), team: body.team_id, author: event.user, text: text || 'Revisa el contexto de este hilo.',
      history: { channel: event.channel, thread: room || (dm && !event.thread_ts) ? undefined : event.thread_ts ?? event.ts,
        latest: event.ts, trigger: `${event.channel}:${event.ts}` } }
    if (!core.authorized(input)) return
    if (!config.slack.allowed_users.length) {
      let entry = membership.get(event.user)
      if (!entry || Date.now() - entry.checkedAt > 300000) {
        const { user } = await api('users.info', { user: event.user })
        entry = { allowed: Boolean(user && !user.is_bot && !user.deleted && !user.is_stranger && user.team_id === config.slack.workspace_team_id), checkedAt: Date.now() }
        membership.set(event.user, entry)
      }
      if (!entry.allowed) return
    }
    output.latestThread.set(key, event.thread_ts ?? event.ts)
    try {
      await core.submit(input)
    } catch (error) {
      await api('chat.postMessage', { channel: event.channel, thread_ts: event.thread_ts ?? event.ts, text: `No pude procesar el mensaje: ${redact((error as Error).message)}` })
    }
  }
  app.event('app_mention', async ({ event, body }) => handle(event, body, true))
  app.message(async ({ message, body }) => handle(message, body))
  app.event('agent_session_stopped' as any, async ({ event, body }: any) => {
    const roomConversation = core.store.db.prepare("SELECT key FROM conversations WHERE adapter='slack' AND channel=? AND thread IS NULL").get(event.channel)
    const key = roomConversation?.key as string ?? (event.channel.startsWith('D') ? `slack:${event.channel}` : `slack:${event.channel}:${event.thread_ts}`)
    const input = { adapter: 'slack' as const, key, eventId: body.event_id, channel: event.channel, thread: event.channel.startsWith('D') ? undefined : event.thread_ts, team: body.team_id, author: event.user, text: 'stop' }
    if (core.authorized(input)) await core.submit(input)
  })
  app.action(/^regent_question_([0-4])$/, async ({ ack, body, action, respond }: any) => {
    await ack()
    try {
      if (body.user?.team_id && body.user.team_id !== config.slack.workspace_team_id) throw new Error('Usuario de otro workspace.')
      const result = await core.answerQuestion(action.value, Number(action.action_id.replace('regent_question_', '')),
        body.user.id, body.team?.id, body.channel?.id, body.message?.thread_ts ?? null)
      await respond({ text: result.duplicate ? 'La pregunta ya fue respondida.' : 'Respuesta registrada.', replace_original: false, response_type: 'ephemeral' })
    } catch (error) { await respond({ text: redact((error as Error).message), replace_original: false, response_type: 'ephemeral' }) }
  })
  app.error(async error => { console.error(`[slack v2] ${redact(error.message)}`) })
  return {
    output,
    rooms,
    connected: () => connected,
    async start(value: Core) {
      core = value
      const auth = await api('auth.test', {})
      if (auth.team_id !== config.slack.workspace_team_id) throw new Error('El token Slack pertenece a otro workspace.')
      botId = auth.user_id
      core.historyLoader = (source, signal, includeOwn) => gatherHistory(api, source, botId, file => readSlackFile(file, process.env.SLACK_BOT_TOKEN!), signal, includeOwn)
      await app.start()
    },
    async stop() { await app.stop(); connected = false },
  }
}
