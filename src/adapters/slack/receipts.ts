import type { Store } from '../../storage/store.ts'

export interface Receipt {
  channel: string
  ts: string
}

/**
 * Where a run's Slack messages landed, so a retry (in this process or after a restart) updates
 * the message already posted instead of posting a duplicate.
 */
export interface Receipts {
  progress(runId: string): Receipt | undefined
  saveProgress(runId: string, receipt: Receipt): void
  forgetProgress(runId: string, ts: string): void
  /** Progress messages whose run is over, moved away or already covered by the activity card. */
  orphanedProgress(): string[]
  finishPage(runId: string, page: number): Receipt | undefined
  saveFinishPage(runId: string, page: number, receipt: Receipt): void
  clearFinishPages(runId: string): void
}

/** In-memory receipts for tests and for an output that has no store attached yet. */
export class MemoryReceipts implements Receipts {
  private progressMessages = new Map<string, Receipt>()
  private finishPages = new Map<string, Map<number, Receipt>>()

  progress(runId: string): Receipt | undefined {
    return this.progressMessages.get(runId)
  }

  saveProgress(runId: string, receipt: Receipt): void {
    this.progressMessages.set(runId, receipt)
  }

  forgetProgress(runId: string): void {
    this.progressMessages.delete(runId)
  }

  orphanedProgress(): string[] {
    return []
  }

  finishPage(runId: string, page: number): Receipt | undefined {
    return this.finishPages.get(runId)?.get(page)
  }

  saveFinishPage(runId: string, page: number, receipt: Receipt): void {
    const pages = this.finishPages.get(runId) ?? new Map<number, Receipt>()
    pages.set(page, receipt)
    this.finishPages.set(runId, pages)
  }

  clearFinishPages(runId: string): void {
    this.finishPages.delete(runId)
  }
}

export class StoredReceipts implements Receipts {
  private store: Store

  constructor(store: Store) {
    this.store = store
  }

  progress(runId: string): Receipt | undefined {
    return this.store.db
      .prepare('SELECT channel,ts FROM slack_progress WHERE run_id=?')
      .get(runId) as Receipt | undefined
  }

  saveProgress(runId: string, receipt: Receipt): void {
    this.store.db
      .prepare('INSERT OR REPLACE INTO slack_progress VALUES(?,?,?)')
      .run(runId, receipt.channel, receipt.ts)
  }

  forgetProgress(runId: string, ts: string): void {
    this.store.db.prepare('DELETE FROM slack_progress WHERE run_id=? AND ts=?').run(runId, ts)
  }

  orphanedProgress(): string[] {
    return this.store.db
      .prepare(
        "SELECT p.run_id FROM slack_progress p LEFT JOIN runs r ON r.id=p.run_id LEFT JOIN conversations c ON c.key=r.conversation_key WHERE r.id IS NULL OR r.state!='running' OR c.channel!=p.channel OR EXISTS(SELECT 1 FROM activity_progress a WHERE a.run_id=p.run_id AND json_extract(a.data,'$.ts') IS NOT NULL AND json_extract(a.data,'$.delivered.channel')=p.channel AND json_extract(a.data,'$.delivered')=json_extract(a.data,'$.desired'))",
      )
      .all()
      .map((row) => row.run_id as string)
  }

  finishPage(runId: string, page: number): Receipt | undefined {
    return this.store.db
      .prepare('SELECT channel,ts FROM slack_finish WHERE run_id=? AND page=?')
      .get(runId, page) as Receipt | undefined
  }

  saveFinishPage(runId: string, page: number, receipt: Receipt): void {
    this.store.db
      .prepare('INSERT OR REPLACE INTO slack_finish(run_id,page,channel,ts) VALUES(?,?,?,?)')
      .run(runId, page, receipt.channel, receipt.ts)
  }

  clearFinishPages(runId: string): void {
    this.store.db.prepare('DELETE FROM slack_finish WHERE run_id=?').run(runId)
  }
}
