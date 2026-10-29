import { activityEvent, activityView, type ActivityState } from '../../core/activities.ts'
import type { Store } from '../../storage/store.ts'
import type { Conversation, Run } from '../../core/types.ts'
import { isSlackError, slackErrorCode, type SlackApi } from './api.ts'

type Destination = { channel: string; thread?: string; team: string | null; author: string }
type Mode = 'stream' | 'blocks' | 'plain'
type Record = {
  state: ActivityState
  desired: Destination
  delivered?: Destination
  ts?: string
  mode: Mode
  revision: number
  sent: number
  closed?: boolean
  nextAt?: number
}

const REFRESH_MS = 3000
const RETRY_MIN_MS = 5000
const LIVE_STATES = ['running', 'queued']

/** Slack rejected the payload shape itself, not the request: fall back to a simpler format. */
const unsupported = (error: unknown) =>
  /\b(invalid_blocks|invalid_arguments|invalid_array_arg|unsupported_block_type|invalid_thread_ts|channel_type_not_supported|feature_disabled)\b/.test(
    slackErrorCode(error),
  )

const sameDestination = (record: Record) =>
  JSON.stringify(record.delivered) === JSON.stringify(record.desired)

/**
 * The live "what the agent is doing" card, one per run, kept apart from the final answer.
 * Only sanitized snapshots are persisted; tool inputs and output never enter here.
 */
export class SlackActivities {
  private api: SlackApi
  private store: Store
  private plain: boolean
  private busy?: Promise<void>

  constructor(api: SlackApi, store: Store, plain = false) {
    this.api = api
    this.store = store
    this.plain = plain
  }

  // State

  get(id: string): Record | undefined {
    const row = this.store.db.prepare('SELECT data FROM activity_progress WHERE run_id=?').get(id)
    return row ? JSON.parse(row.data as string) : undefined
  }

  save(id: string, record: Record) {
    this.store.db
      .prepare(
        'INSERT INTO activity_progress VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET data=excluded.data',
      )
      .run(id, JSON.stringify(record))
  }

  destination(c: Conversation, run: Run): Destination {
    return {
      channel: c.channel,
      thread: c.thread ?? (c.channel.startsWith('D') ? (run.reply_thread ?? undefined) : undefined),
      team: c.team,
      author: run.author,
    }
  }

  modeFor(desired: Destination): Mode {
    if (this.plain) return 'plain'
    return desired.thread ? 'stream' : 'blocks'
  }

  event(c: Conversation, run: Run, event: any) {
    const desired = this.destination(c, run)
    const record = this.get(run.id) ?? {
      state: { calls: {} },
      desired,
      mode: this.modeFor(desired),
      revision: 0,
      sent: -1,
    }

    if (!activityEvent(record.state, event)) return
    record.desired = desired
    record.revision++
    this.save(run.id, record)
    void this.flush()
  }

  terminal(run: Run) {
    const record = this.get(run.id)
    if (!record || record.state.terminal) return
    record.state.terminal = this.store.run(run.id)?.state ?? 'interrupted'
    record.revision++
    record.nextAt = 0
    this.save(run.id, record)
  }

  move(run: Run) {
    const record = this.get(run.id)
    const c = this.store.conversation(run.conversation_key)

    if (!record || !c) return
    record.desired = this.destination(c, run)
    record.revision++
    this.save(run.id, record)
  }

  // Delivery

  flush(): Promise<void> {
    if (this.busy) return this.busy
    this.busy = this.drain()
      .catch((error) => console.error(`[slack progress] ${slackErrorCode(error).slice(0, 100)}`))
      .finally(() => {
        this.busy = undefined
      })
    return this.busy
  }

  private async drain() {
    for (const row of this.pendingRows()) {
      const id = row.run_id as string
      const record: Record = JSON.parse(row.data as string)
      this.closeIfRunEnded(id, record)
      if (record.sent === record.revision || Date.now() < (record.nextAt ?? 0)) continue

      try {
        await this.deliver(id, record)
      } catch (error) {
        await this.scheduleRetry(id, record, error)
      }
    }
  }

  private pendingRows() {
    return this.store.db
      .prepare(
        "SELECT run_id,data FROM activity_progress WHERE json_extract(data,'$.sent') != json_extract(data,'$.revision') OR json_extract(data,'$.state.terminal') IS NULL",
      )
      .all()
  }

  /** A run that ended without a terminal event (crash, restart) still gets its card closed. */
  private closeIfRunEnded(id: string, record: Record) {
    if (record.state.terminal) return
    const run = this.store.run(id)
    if (run && LIVE_STATES.includes(run.state)) return
    record.state.terminal = run?.state ?? 'interrupted'
    record.revision++
    this.save(id, record)
  }

  private async deliver(id: string, record: Record) {
    if (this.plain && record.mode !== 'plain') {
      await this.stop(record)
      record.mode = 'plain'
    }
    // If native cards are unavailable, stay quiet instead of posting plaintext progress.
    if (record.mode === 'plain') {
      this.merge(id, record, true)
      return
    }
    if (record.ts && !sameDestination(record)) await this.relocate(record)

    if (!record.ts) await this.post(id, record)
    else if (record.mode === 'stream' && !record.closed) await this.append(record)
    if (record.state.terminal) await this.stop(record)
    if (record.mode !== 'stream' || record.state.terminal) await this.update(record)
    record.nextAt = Date.now() + REFRESH_MS
    this.merge(id, record, true)
  }

  /** The conversation moved: freeze the old card as "moved" and start fresh at the destination. */
  private async relocate(record: Record) {
    await this.stop(record)
    await this.api('chat.update', {
      channel: record.delivered!.channel,
      ts: record.ts,
      ...this.payload(record, 'moved'),
    })
    record.ts = undefined
    record.closed = false
    record.mode = this.modeFor(record.desired)
  }

  private async post(id: string, record: Record) {
    record.delivered = record.desired
    const args = { channel: record.desired.channel, thread_ts: record.desired.thread }
    let response: any

    if (record.mode === 'stream') {
      response = await this.api('chat.startStream', {
        ...args,
        recipient_user_id: record.desired.author,
        recipient_team_id: record.desired.team,
        task_display_mode: 'timeline',
        chunks: this.chunks(record.state),
      })
    } else {
      response = await this.api('chat.postMessage', {
        ...args,
        ...this.payload(record),
        unfurl_links: false,
      })
    }

    if (!response.ts) throw new Error('missing_progress_ts')
    record.ts = response.ts
    // Persist the receipt immediately; merge new events received during HTTP.
    this.merge(id, record, false)
  }

  private async append(record: Record) {
    try {
      await this.api('chat.appendStream', {
        channel: record.delivered!.channel,
        ts: record.ts,
        chunks: this.chunks(record.state),
      })
    } catch (error) {
      if (!isSlackError(error, 'message_not_in_streaming_state')) throw error
      record.closed = true
      record.mode = 'blocks'
    }
  }

  private async update(record: Record) {
    await this.api('chat.update', {
      channel: record.delivered!.channel,
      ts: record.ts,
      ...this.payload(record),
    })
  }

  private async stop(record: Record) {
    if (!record.ts || record.mode !== 'stream' || record.closed) return

    try {
      await this.api('chat.stopStream', { channel: record.delivered!.channel, ts: record.ts })
    } catch (error) {
      if (!isSlackError(error, 'message_not_in_streaming_state')) throw error
    }

    record.closed = true
  }

  private async scheduleRetry(id: string, record: Record, error: any) {
    if (unsupported(error)) {
      // Do not abandon a live stream when only its next payload is rejected.
      try {
        await this.stop(record)
        record.mode = record.mode === 'stream' ? 'blocks' : 'plain'
      } catch {
        /* Retry closing the original stream before changing its format. */
      }
    }

    if (isSlackError(error, 'message_not_found')) {
      record.ts = undefined
      record.closed = false
    }

    const retryAfter = Number(error?.retryAfter ?? error?.data?.retry_after ?? 5) * 1000
    record.nextAt = Date.now() + Math.max(RETRY_MIN_MS, retryAfter)
    this.merge(id, record, false)
    const cause = unsupported(error) ? 'unsupported format; fallback' : 'transport; retry pending'
    console.error(`[slack progress] delivery failed: ${cause}`)
  }

  /** Writes the delivery outcome without losing events that arrived while the request was in flight. */
  private merge(id: string, sent: Record, success: boolean) {
    const latest = this.get(id) ?? sent
    this.save(id, {
      ...latest,
      ts: sent.ts,
      delivered: sent.delivered,
      mode: sent.mode,
      closed: sent.closed,
      nextAt: sent.nextAt,
      sent: success ? sent.revision : latest.sent,
    })
  }

  // Payloads

  private payload(record: Record, terminal?: string) {
    const view = activityView(terminal ? { ...record.state, terminal } : record.state)
    const rich = (text: string) => ({
      type: 'rich_text',
      elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text }] }],
    })

    return {
      text: view.text,
      blocks: [
        { type: 'context', elements: [{ type: 'plain_text', text: view.title }] },
        ...view.tasks.map(({ id, output, details, ...task }) => ({
          type: 'task_card',
          task_id: id,
          ...task,
          ...(details ? { details: rich(details) } : {}),
          output: rich(output),
        })),
      ],
    }
  }

  private chunks(state: ActivityState) {
    // Slack appends task output/details. Snapshots belong in chat.update, never appendStream.
    return activityView(state).tasks.map(({ id, title, status }) => ({
      type: 'task_update',
      id,
      title,
      status,
    }))
  }
}
