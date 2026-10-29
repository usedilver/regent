import type { Conversation, Output, Run } from '../../core/types.ts'
import type { ActivityEvent } from '../../core/activities.ts'
import { redact } from '../../storage/redact.ts'
import type { Store } from '../../storage/store.ts'
import type { SlackActivities } from './activities.ts'
import { isSlackError, slackErrorCode, type SlackApi } from './api.ts'
import { replyPayloads } from './format.ts'
import { MemoryReceipts, StoredReceipts, type Receipt, type Receipts } from './receipts.ts'

const PLAIN_SECTION_CHARS = 2800

type Status = 'processing' | 'active' | 'suspended'

type ReplyTarget = { channel: string; thread: string | null | undefined }

export class SlackOutput implements Output {
  api: SlackApi
  activities?: SlackActivities
  nativeStatuses = new Set<string>()
  latestThread = new Map<string, string>()
  private attached?: Store
  private receipts: Receipts = new MemoryReceipts()

  constructor(api: SlackApi) {
    this.api = api
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

  /** The native indicator requires a thread anchor; channel-root activity uses cards. */
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

  // Activity-only progress

  async progress(c: Conversation, run: Run, text: string): Promise<void> {
    await this.clearProgress(run)
    this.activities?.event(c, run, { kind: 'progress', text })
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

  // Intermediate model prose is not a Slack message; progress uses the activity timeline.
  async delta(_c: Conversation, _run: Run, _text: string): Promise<void> {}

  // Final reply

  async finish(c: Conversation, run: Run, text: string): Promise<void> {
    this.activities?.terminal(run)
    await this.finishReply(c, run, text)
    await this.clearProgress(run)
  }

  async finishReply(c: Conversation, run: Run, text: string): Promise<void> {
    const target = { channel: c.channel, thread: this.anchor(c) ?? c.thread ?? null }
    await this.postPages(run, replyPayloads(redact(text)), target)
    this.receipts.clearFinishPages(run.id)
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
    for (let i = 0; i < pages.length; i++) {
      // Delivered on a prior attempt. The finish text does not change between retries,
      // and re-updating could exceed the chat.update limit.
      if (this.receipts.finishPage(run.id, i)) continue

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

  /** Subsequent activity and the final result follow the conversation to its room. */
  async moved(run: Run): Promise<void> {
    this.activities?.move(run)
    await this.clearProgress(run)
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
