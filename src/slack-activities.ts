import { activityEvent, activityView, type ActivityState } from './activities.ts'
import type { Store } from './store.ts'
import type { Conversation, Run } from './types.ts'

type Destination = { channel: string; thread?: string; team: string | null; author: string }
type Record = { state: ActivityState; desired: Destination; delivered?: Destination; ts?: string;
  mode: 'stream' | 'blocks' | 'plain'; revision: number; sent: number; closed?: boolean; nextAt?: number }
type Api = (method: string, args: any) => Promise<any>
const code = (error: any) => error?.data?.error ?? error?.message ?? ''
const unsupported = (error: any) => /\b(invalid_blocks|invalid_arguments|invalid_array_arg|unsupported_block_type|invalid_thread_ts|channel_type_not_supported|feature_disabled)\b/.test(code(error))

// A separate progress message keeps the authoritative final answer independent.
// Only sanitized snapshots are persisted; tool inputs and output never enter here.
export class SlackActivities {
  private api: Api
  private store: Store
  private plain: boolean
  private busy?: Promise<void>
  constructor(api: Api, store: Store, plain = false) { this.api = api; this.store = store; this.plain = plain }
  get(id: string): Record | undefined {
    const row = this.store.db.prepare('SELECT data FROM activity_progress WHERE run_id=?').get(id)
    return row ? JSON.parse(row.data as string) : undefined
  }
  save(id: string, record: Record) {
    this.store.db.prepare('INSERT INTO activity_progress VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET data=excluded.data').run(id, JSON.stringify(record))
  }
  destination(c: Conversation, run: Run): Destination {
    return { channel: c.channel, thread: c.thread ?? (c.channel.startsWith('D') ? run.reply_thread ?? undefined : undefined), team: c.team, author: run.author }
  }
  event(c: Conversation, run: Run, event: any) {
    const desired = this.destination(c, run)
    const record = this.get(run.id) ?? { state: { calls: {} }, desired, mode: this.plain ? 'plain' : desired.thread ? 'stream' : 'blocks', revision: 0, sent: -1 }
    if (!activityEvent(record.state, event)) return
    record.desired = desired; record.revision++; this.save(run.id, record)
    void this.flush()
  }
  terminal(run: Run) {
    const record = this.get(run.id)
    if (!record || record.state.terminal) return
    record.state.terminal = this.store.run(run.id)?.state ?? 'interrupted'
    record.revision++; record.nextAt = 0; this.save(run.id, record)
  }
  move(run: Run) {
    const record = this.get(run.id), c = this.store.conversation(run.conversation_key)
    if (!record || !c) return
    record.desired = this.destination(c, run); record.revision++; this.save(run.id, record)
  }
  flush(): Promise<void> {
    if (this.busy) return this.busy
    this.busy = this.drain().catch(error => console.error(`[slack progress] ${code(error).slice(0,100)}`)).finally(() => { this.busy = undefined })
    return this.busy
  }
  private async stop(record: Record) {
    if (!record.ts || record.mode !== 'stream' || record.closed) return
    try { await this.api('chat.stopStream', { channel: record.delivered!.channel, ts: record.ts }) }
    catch (error) { if (!/\bmessage_not_in_streaming_state\b/.test(code(error))) throw error }
    record.closed = true
  }
  private payload(record: Record, terminal?: string) {
    const view = activityView(terminal ? { ...record.state, terminal } : record.state)
    const rich = (text: string) => ({ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text }] }] })
    return { text: view.text, blocks: record.mode === 'plain' ? [{ type: 'section', text: { type: 'plain_text', text: view.text } }] :
      [{ type: 'context', elements: [{ type: 'plain_text', text: view.title }] },
        ...view.tasks.map(({ id, output, details, ...task }) => ({ type: 'task_card', task_id: id, ...task,
          ...(details ? { details: rich(details) } : {}),
          output: rich(output) }))] }
  }
  private chunks(state: ActivityState) {
    // Slack appends task output/details. Snapshots belong in chat.update, never appendStream.
    return activityView(state).tasks.map(({ id, title, status }) => ({ type: 'task_update', id, title, status }))
  }
  private async drain() {
    for (const row of this.store.db.prepare("SELECT run_id,data FROM activity_progress WHERE json_extract(data,'$.sent') != json_extract(data,'$.revision') OR json_extract(data,'$.state.terminal') IS NULL").all()) {
      const id = row.run_id as string
      const record: Record = JSON.parse(row.data as string)
      const run = this.store.run(id)
      if (!record.state.terminal && (!run || !['running','queued'].includes(run.state))) {
        record.state.terminal = run?.state ?? 'interrupted'; record.revision++; this.save(id, record)
      }
      if (record.sent === record.revision || Date.now() < (record.nextAt ?? 0)) continue
      try {
        if (record.ts && JSON.stringify(record.delivered) !== JSON.stringify(record.desired)) {
          await this.stop(record)
          await this.api('chat.update', { channel: record.delivered!.channel, ts: record.ts, ...this.payload(record, 'moved') })
          record.ts = undefined; record.closed = false
          record.mode = this.plain ? 'plain' : record.desired.thread ? 'stream' : 'blocks'
        }
        if (this.plain && record.mode !== 'plain') { await this.stop(record); record.mode = 'plain' }
        if (!record.ts) {
          record.delivered = record.desired
          const args = { channel: record.desired.channel, thread_ts: record.desired.thread }
          const response = record.mode === 'stream' ? await this.api('chat.startStream', { ...args,
            recipient_user_id: record.desired.author, recipient_team_id: record.desired.team,
            task_display_mode: 'timeline', chunks: this.chunks(record.state) }) :
            await this.api('chat.postMessage', { ...args, ...this.payload(record), unfurl_links: false })
          if (!response.ts) throw new Error('missing_progress_ts')
          record.ts = response.ts
          // Persist the receipt immediately; merge new events received during HTTP.
          this.merge(id, record, false)
        } else if (record.mode === 'stream' && !record.closed) {
          try { await this.api('chat.appendStream', { channel: record.delivered!.channel, ts: record.ts,
            chunks: this.chunks(record.state) }) }
          catch (error) { if (!/\bmessage_not_in_streaming_state\b/.test(code(error))) throw error; record.closed = true; record.mode = 'blocks' }
        }
        if (record.state.terminal) await this.stop(record)
        if (record.mode !== 'stream' || record.state.terminal) await this.api('chat.update', { channel: record.delivered!.channel, ts: record.ts, ...this.payload(record) })
        record.nextAt = Date.now() + 3000
        this.merge(id, record, true)
      } catch (error: any) {
        if (unsupported(error)) {
          // Do not abandon a live stream when only its next payload is rejected.
          try { await this.stop(record); record.mode = record.mode === 'stream' ? 'blocks' : 'plain' }
          catch { /* Retry closing the original stream before changing its format. */ }
        }
        if (/\bmessage_not_found\b/.test(code(error))) { record.ts = undefined; record.closed = false }
        record.nextAt = Date.now() + Math.max(5000, Number(error?.retryAfter ?? error?.data?.retry_after ?? 5) * 1000)
        this.merge(id, record, false)
        console.error(`[slack progress] delivery failed: ${unsupported(error) ? 'unsupported format; fallback' : 'transport; retry pending'}`)
      }
    }
  }
  private merge(id: string, sent: Record, success: boolean) {
    const latest = this.get(id) ?? sent
    this.save(id, { ...latest, ts: sent.ts, delivered: sent.delivered, mode: sent.mode,
      closed: sent.closed, nextAt: sent.nextAt, sent: success ? sent.revision : latest.sent })
  }
}
