import type { Conversation, Output, Run } from '../../core/types.ts'
import type { ActivityEvent } from '../../core/activities.ts'
import { redact } from '../../storage/redact.ts'
import type { Store } from '../../storage/store.ts'
import type { SlackActivities } from './activities.ts'
import { isSlackError, slackErrorCode, type SlackApi } from './api.ts'
import { replyPayloads } from './format.ts'
import { MemoryReceipts, StoredReceipts, type Receipt, type Receipts } from './receipts.ts'

// chat.update caps its text at 4000 chars (chat.postMessage does not); a bigger page can only
// land as a fresh post. Kept under that with a margin for multibyte counting differences.
const CHAT_UPDATE_LIMIT = 3800
/** Redaction needs whole lines, so a flush takes the text up to the last newline near this size. */
const STREAM_FLUSH_CHARS = 11000
const PLAIN_SECTION_CHARS = 2800

type Status = 'processing' | 'active' | 'suspended'

type Stream = {
  ts?: string
  pending: string
  sent: string
  timer?: NodeJS.Timeout
  chain: Promise<void>
  failed?: boolean
  channel: string
  thread?: string
}

/** Where a final reply goes: the streamed placeholder when there is one, else the thread anchor. */
type ReplyTarget = { channel: string; thread: string | null | undefined; placeholder?: string }

export class SlackOutput implements Output {
  api: SlackApi
  flushMs: number
  activities?: SlackActivities
  streams = new Map<string, Stream>()
  nativeStatuses = new Set<string>()
  latestThread = new Map<string, string>()
  private attached?: Store
  private receipts: Receipts = new MemoryReceipts()

  constructor(api: SlackApi, flushMs = 3000) {
    this.api = api
    this.flushMs = flushMs
  }

  /** With a store attached, message receipts survive restarts; without one they live in memory. */
  get store(): Store | undefined {
    return this.attached
  }

  set store(value: Store | undefined) {
    this.attached = value
    this.receipts = value ? new StoredReceipts(value) : new MemoryReceipts()
  }

  activity(c: Conversation, run: Run, event: ActivityEvent): void {
    this.activities?.event(c, run, event)
  }

  /** The native "working…" indicator (agents.sessions.setStatus) needs a thread anchor. Rooms
   * converse at channel root with no anchor, so the core falls back to the progress message. */
  animates(c: Conversation): boolean {
    return this.nativeStatuses.has(JSON.stringify([c.channel, this.anchor(c)]))
  }

  /** DMs anchor each response to its request; a room converses at channel root. */
  anchor(c: Conversation): string | undefined {
    return c.thread ?? (c.channel.startsWith('D') ? this.latestThread.get(c.key) : undefined)
  }

  // Messages

  async question(
    c: Conversation,
    question: { id: string; text: string; options: string[] },
  ): Promise<void> {
    if (!question.options.length) return this.notice(c, question.text)
    const text = redact(question.text)
    const options = question.options.map((o, i) => `${i + 1}. ${redact(o)}`).join('\n')

    await this.api('chat.postMessage', {
      channel: c.channel,
      thread_ts: c.thread ?? undefined,
      text: `${text}\n${options}`,
      unfurl_links: false,
      blocks: [
        { type: 'section', text: { type: 'plain_text', text } },
        { type: 'section', text: { type: 'plain_text', text: options } },
        {
          type: 'actions',
          elements: question.options.map((_, i) => ({
            type: 'button',
            text: { type: 'plain_text', text: `Opcion ${i + 1}` },
            action_id: `regent_question_${i}`,
            value: question.id,
          })),
        },
      ],
    })
  }

  async notice(c: Conversation, text: string): Promise<void> {
    for (const payload of replyPayloads(redact(text))) {
      await this.sendReply('chat.postMessage', {
        channel: c.channel,
        thread_ts: c.thread ?? undefined,
        unfurl_links: false,
        unfurl_media: false,
        ...payload,
      })
    }
  }

  /** Posts or updates a reply, falling back to plain sections where Markdown blocks are rejected. */
  async sendReply(method: string, args: any): Promise<any> {
    try {
      return await this.api(method, args)
    } catch (error) {
      const markdownRejected = /\b(invalid_blocks|unsupported_block_type)\b/.test(
        slackErrorCode(error),
      )

      if (!markdownRejected || args.blocks?.[0]?.type !== 'markdown') throw error
      return await this.api(method, { ...args, blocks: plainSections(args.text), mrkdwn: false })
    }
  }

  async status(c: Conversation, status: Status): Promise<void> {
    const thread = this.anchor(c)
    // agents.sessions.setStatus needs a thread anchor. Rooms have none, and the core's progress
    // message already covers them, so skip quietly instead of posting a duplicate text ack.
    if (thread === undefined) return
    const key = JSON.stringify([c.channel, thread])

    try {
      await this.api('agents.sessions.setStatus', {
        channel_id: c.channel,
        thread_ts: thread,
        status,
        initiator_user_id: c.author,
      })
      if (status === 'processing') this.nativeStatuses.add(key)
      else this.nativeStatuses.delete(key)
    } catch (error) {
      this.nativeStatuses.delete(key)
      console.error(`[slack v2] setStatus ${status}: ${redact((error as Error).message)}`)
    }
  }

  // Progress message

  /** When native activity is unavailable: post one "working…" message and refresh it in
   * place on each tick, so there are no repeated posts. clearProgress removes it when done. */
  async progress(c: Conversation, run: Run, text: string): Promise<void> {
    if (this.activityCardCovers(c, run)) {
      await this.clearProgress(run)
      return
    }

    let existing = this.progressMessage(run.id)

    if (existing && existing.channel !== c.channel) {
      await this.clearProgress(run)
      if (this.progressMessage(run.id)) return
      existing = undefined
    }

    try {
      if (existing) {
        await this.api('chat.update', {
          channel: existing.channel,
          ts: existing.ts,
          text: redact(text),
        })
      } else {
        await this.postProgress(c, run, text)
      }
    } catch (error) {
      if (existing && isSlackError(error, 'message_not_found')) {
        this.forgetProgress(run.id, existing.ts)
      }

      console.error(`[slack v2] progress: ${redact((error as Error).message)}`)
    }
  }

  /** The activity card already shows live progress where this conversation is anchored. */
  private activityCardCovers(c: Conversation, run: Run): boolean {
    const activity = this.activities?.get(run.id)
    if (!activity?.ts) return false
    return (
      activity.delivered?.channel === c.channel && activity.delivered?.thread === this.anchor(c)
    )
  }

  private async postProgress(c: Conversation, run: Run, text: string): Promise<void> {
    const result = await this.api('chat.postMessage', {
      channel: c.channel,
      thread_ts: this.anchor(c),
      text: redact(text),
      unfurl_links: false,
    })

    if (result.ts) this.receipts.saveProgress(run.id, { channel: c.channel, ts: result.ts })
  }

  /** Remove the run's progress message once the real reply lands (or the conversation moves). */
  async clearProgress(run: Run): Promise<void> {
    const receipt = this.progressMessage(run.id)
    if (!receipt) return

    try {
      await this.api('chat.delete', { channel: receipt.channel, ts: receipt.ts })
    } catch (error) {
      if (!isSlackError(error, 'message_not_found')) {
        console.error(`[slack v2] clearProgress: ${redact((error as Error).message)}`)
        return
      }
    }

    this.forgetProgress(run.id, receipt.ts)
  }

  forgetProgress(id: string, ts: string): void {
    this.receipts.forgetProgress(id, ts)
  }

  progressMessage(id: string): Receipt | undefined {
    return this.receipts.progress(id)
  }

  async recoverProgress(): Promise<void> {
    await this.activities?.flush()
    for (const id of this.receipts.orphanedProgress()) await this.clearProgress({ id } as Run)
  }

  // Streamed reply

  async delta(c: Conversation, run: Run, text: string): Promise<void> {
    const stream = this.streams.get(run.id) ?? this.openStream(c, run)
    stream.pending += text
    if (stream.timer) return

    stream.timer = setTimeout(() => {
      stream.timer = undefined
      stream.chain = stream.chain
        .then(() => this.flushStream(c, run, stream))
        .catch(() => {
          stream.failed = true
        })
    }, this.flushMs)
  }

  private openStream(c: Conversation, run: Run): Stream {
    const stream: Stream = {
      pending: '',
      sent: '',
      chain: Promise.resolve(),
      channel: c.channel,
      thread: this.anchor(c),
    }

    this.streams.set(run.id, stream)
    return stream
  }

  private async flushStream(c: Conversation, run: Run, stream: Stream): Promise<void> {
    if (!stream.pending || stream.failed) return
    // Redact complete lines: token and key/value pairs can span many deltas.
    const end = stream.pending.lastIndexOf('\n', STREAM_FLUSH_CHARS) + 1
    if (!end) return
    const raw = stream.pending.slice(0, end)
    const text = redact(raw)

    if (!stream.ts) {
      const result = await this.api('chat.startStream', {
        channel: stream.channel,
        thread_ts: stream.thread,
        recipient_user_id: run.author,
        recipient_team_id: c.team,
        markdown_text: text,
      })

      if (!result.ts) throw new Error('Slack no devolvio ts del stream.')
      stream.ts = result.ts
    } else {
      await this.api('chat.appendStream', {
        channel: stream.channel,
        ts: stream.ts,
        markdown_text: text,
      })
    }

    stream.sent += text
    stream.pending = stream.pending.slice(raw.length)
  }

  private async stopStream(channel: string, ts: string): Promise<void> {
    try {
      await this.api('chat.stopStream', { channel, ts })
    } catch (error) {
      if (!isSlackError(error, 'message_not_in_streaming_state')) throw error
    }
  }

  // Final reply

  async finish(c: Conversation, run: Run, text: string): Promise<void> {
    this.activities?.terminal(run)
    await this.finishReply(c, run, text)
    await this.clearProgress(run)
  }

  async finishReply(c: Conversation, run: Run, text: string): Promise<void> {
    const target = await this.replyTarget(c, run)
    await this.postPages(run, replyPayloads(redact(text)), target)
    this.receipts.clearFinishPages(run.id)
    this.streams.delete(run.id)
  }

  private async replyTarget(c: Conversation, run: Run): Promise<ReplyTarget> {
    const stream = this.streams.get(run.id)
    if (!stream) return { channel: c.channel, thread: this.anchor(c) ?? c.thread ?? null }
    clearTimeout(stream.timer)
    await stream.chain
    if (stream.ts) await this.stopStream(stream.channel, stream.ts)
    // Page 0 replaces the streamed message; the authoritative result can differ from it.
    return { channel: stream.channel, thread: stream.thread ?? null, placeholder: stream.ts }
  }

  /**
   * Idempotent multi-page send: on a retry, a page already posted is updated in place, never
   * re-posted. A mid-send failure rethrows for DurableOutput to retry the whole finish; the
   * pages already recorded are not duplicated.
   */
  private async postPages(
    run: Run,
    pages: ReturnType<typeof replyPayloads>,
    target: ReplyTarget,
  ): Promise<void> {
    let placeholder = target.placeholder

    for (let i = 0; i < pages.length; i++) {
      // Delivered on a prior attempt. The finish text does not change between retries,
      // and re-updating could exceed the chat.update limit.
      if (this.receipts.finishPage(run.id, i)) continue

      if (i === 0 && placeholder && pages[i].text.length <= CHAT_UPDATE_LIMIT) {
        await this.sendReply('chat.update', {
          channel: target.channel,
          ts: placeholder,
          ...pages[i],
        })
        this.receipts.saveFinishPage(run.id, i, { channel: target.channel, ts: placeholder })
        continue
      }

      if (i === 0 && placeholder) {
        // The streamed placeholder cannot hold a reply above chat.update's limit; retire it and post fresh.
        await this.api('chat.delete', { channel: target.channel, ts: placeholder }).catch(() => {})
        placeholder = undefined
      }

      const result = await this.sendReply('chat.postMessage', {
        channel: target.channel,
        thread_ts: target.thread ?? undefined,
        unfurl_links: false,
        unfurl_media: false,
        ...pages[i],
      })

      if (result?.ts) {
        this.receipts.saveFinishPage(run.id, i, { channel: target.channel, ts: result.ts })
      }
    }
  }

  /** The conversation moved to its room: close the origin stream so the rest lands there. */
  async moved(run: Run): Promise<void> {
    this.activities?.move(run)
    await this.clearProgress(run)
    const stream = this.streams.get(run.id)
    if (!stream) return
    this.streams.delete(run.id)
    clearTimeout(stream.timer)
    await stream.chain.catch(() => {})
    if (stream.failed || !stream.ts) return

    try {
      const tail = redact(stream.pending)

      if (tail.trim()) {
        await this.api('chat.appendStream', {
          channel: stream.channel,
          ts: stream.ts,
          markdown_text: tail,
        })
      }

      await this.api('chat.stopStream', { channel: stream.channel, ts: stream.ts })
    } catch (error) {
      console.error(`[slack v2] cierre de stream al mover: ${redact((error as Error).message)}`)
    }
  }
}

/** The same text as plain sections, for workspaces where Markdown blocks are unavailable. */
function plainSections(text: string): unknown[] {
  const blocks: unknown[] = []

  for (let i = 0; i < text.length; i += PLAIN_SECTION_CHARS) {
    blocks.push({
      type: 'section',
      text: { type: 'plain_text', text: text.slice(i, i + PLAIN_SECTION_CHARS), emoji: false },
    })
  }

  return blocks
}
