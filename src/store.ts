import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { Conversation, Inbound, Run } from './types.ts'

export function redact(text: string): string {
  return text.replace(/\b(?:sk-ant-|sk-|xox[baprs]-|xapp-|gh[pousr]_|github_pat_|ntn_)[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/(Bearer\s+)[^\s"\\]+/gi, '$1[REDACTED]')
    .replace(/((?:password|api[_-]?key|secret|access[_-]?token)\s*["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]')
}

export class Store {
  db: DatabaseSync
  owner = randomUUID()
  ownsRuntime = false
  constructor(file: string) {
    if (file !== ':memory:') {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      fs.closeSync(fs.openSync(file, 'a', 0o600))
      fs.chmodSync(file, 0o600)
    }
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    const version = this.db.prepare('PRAGMA user_version').get()!.user_version as number
    if (version > 9) throw new Error(`Esquema SQLite ${version} mas nuevo que este servidor.`)
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS conversations (
          key TEXT PRIMARY KEY, adapter TEXT NOT NULL, channel TEXT NOT NULL, thread TEXT,
          team TEXT, author TEXT NOT NULL, cwd TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'idle',
          session_id TEXT, updated_at INTEGER NOT NULL, task_id TEXT
        );
        CREATE TABLE IF NOT EXISTS inbound (
          adapter TEXT NOT NULL, event_id TEXT NOT NULL, run_id TEXT, PRIMARY KEY(adapter,event_id)
        );
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY, conversation_key TEXT NOT NULL REFERENCES conversations(key),
          author TEXT NOT NULL, prompt TEXT NOT NULL, transcript TEXT, reply_thread TEXT, state TEXT NOT NULL,
          created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,
          result TEXT, error TEXT, cost REAL NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS runs_queue ON runs(state,created_at);
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id),
          kind TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS usage (
          run_id TEXT PRIMARY KEY REFERENCES runs(id), author TEXT NOT NULL, day TEXT NOT NULL,
          cost REAL NOT NULL, tokens TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS gates (
          conversation_key TEXT PRIMARY KEY REFERENCES conversations(key), question TEXT NOT NULL,
          state TEXT NOT NULL, answer TEXT
        );
        CREATE TABLE IF NOT EXISTS legacy (source TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runtime (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, owner TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS deliveries (
          id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_key TEXT NOT NULL,
          kind TEXT NOT NULL, args TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0, error TEXT
        );
      `)
      if (version < 2) {
        this.db.exec(`
          ALTER TABLE runs ADD COLUMN reply_channel TEXT;
          ALTER TABLE runs ADD COLUMN intent TEXT NOT NULL DEFAULT 'ask';
          CREATE TABLE tasks (
            id TEXT PRIMARY KEY, conversation_key TEXT NOT NULL REFERENCES conversations(key), title TEXT NOT NULL,
            size TEXT NOT NULL, impact TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'planning',
            notion_id TEXT, url TEXT, room TEXT, room_thread TEXT, created_at INTEGER NOT NULL
          );
          CREATE TABLE task_gates (
            id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL,
            revision TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', actor TEXT, decided_at INTEGER,
            conversation TEXT NOT NULL, questions TEXT NOT NULL DEFAULT '[]', dispatched INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE worktrees (
            id TEXT PRIMARY KEY, conversation_key TEXT NOT NULL REFERENCES conversations(key), repo TEXT NOT NULL,
            dir TEXT NOT NULL UNIQUE, branch TEXT NOT NULL, base TEXT NOT NULL, base_sha TEXT NOT NULL,
            origin TEXT NOT NULL, test_command TEXT, test_tree TEXT, test_passed INTEGER NOT NULL DEFAULT 0,
            state TEXT NOT NULL DEFAULT 'active', UNIQUE(conversation_key,repo)
          );
          CREATE TABLE prs (
            worktree_id TEXT PRIMARY KEY REFERENCES worktrees(id), url TEXT NOT NULL, head TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'OPEN'
          );
          CREATE TABLE effects (
            key TEXT PRIMARY KEY, state TEXT NOT NULL, result TEXT, error TEXT
          );
          CREATE TABLE sections (
            task_id TEXT NOT NULL REFERENCES tasks(id), section TEXT NOT NULL, md TEXT NOT NULL,
            revision TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY(task_id,section)
          );
          PRAGMA user_version=2;
        `)
      }
      if (version < 3) this.db.exec(`
        ALTER TABLE gates ADD COLUMN question_id TEXT;
        ALTER TABLE gates ADD COLUMN options TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE gates ADD COLUMN destination TEXT;
        CREATE UNIQUE INDEX gates_question_id ON gates(question_id);
        PRAGMA user_version=3;
      `)
      if (version < 4) this.db.exec(`
        CREATE TABLE IF NOT EXISTS approvals (
          id TEXT PRIMARY KEY, conversation_key TEXT NOT NULL, command TEXT NOT NULL, cwd TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending', requested_by TEXT NOT NULL, actor TEXT,
          conversation TEXT NOT NULL, created_at INTEGER NOT NULL, decided_at INTEGER
        );
        PRAGMA user_version=4;
      `)
      if (version < 5) this.db.exec(`
        CREATE TABLE IF NOT EXISTS conversation_history (conversation_key TEXT PRIMARY KEY, source TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS run_history (run_id TEXT PRIMARY KEY REFERENCES runs(id), source TEXT NOT NULL, snapshot TEXT);
        CREATE TABLE IF NOT EXISTS history_seen (conversation_key TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL, hash TEXT NOT NULL,
          PRIMARY KEY(conversation_key,session_id,message_id));
        PRAGMA user_version=5;
      `)
      if (version < 6) this.db.exec(`
        CREATE TABLE IF NOT EXISTS room_transfers (
          conversation_key TEXT PRIMARY KEY REFERENCES conversations(key), name TEXT NOT NULL UNIQUE,
          channel TEXT UNIQUE, origin TEXT NOT NULL, summary TEXT NOT NULL, users TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending'
        );
        PRAGMA user_version=6;
      `)
      if (version < 7) this.db.exec(`
        CREATE TABLE IF NOT EXISTS slack_progress (run_id TEXT PRIMARY KEY, channel TEXT NOT NULL, ts TEXT NOT NULL);
        PRAGMA user_version=7;
      `)
      if (version < 8) this.db.exec(`
        CREATE TABLE IF NOT EXISTS activity_progress (run_id TEXT PRIMARY KEY, data TEXT NOT NULL);
        PRAGMA user_version=8;
      `)
      if (version < 9) this.db.exec(`
        CREATE TABLE IF NOT EXISTS slack_finish (run_id TEXT NOT NULL, page INTEGER NOT NULL, channel TEXT NOT NULL, ts TEXT NOT NULL, PRIMARY KEY(run_id,page));
        PRAGMA user_version=9;
      `)
    })
  }
  claimRuntime(): void {
    this.transaction(() => {
      const existing = this.db.prepare('SELECT pid FROM runtime WHERE id=1').get()
      if (existing) {
        let alive = true
        try { process.kill(existing.pid as number, 0) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false }
        if (alive) throw new Error(`Esta base ya tiene un runtime activo (PID ${existing.pid}). Usa otra REGENT_DB o deten ese proceso.`)
      }
      this.db.prepare('INSERT OR REPLACE INTO runtime VALUES(1,?,?)').run(process.pid, this.owner)
      this.ownsRuntime = true
    })
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  conversation(key: string): Conversation | undefined {
    return this.db.prepare('SELECT * FROM conversations WHERE key=?').get(key) as unknown as Conversation | undefined
  }
  run(id: string): Run | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as unknown as Run | undefined
  }
  accept(input: Inbound, cwd: string, idleHours: number, switchContext = false): { duplicate: boolean; runId: string | null; command: string | null } {
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT run_id FROM inbound WHERE adapter=? AND event_id=?').get(input.adapter, input.eventId)
      if (previous) return { duplicate: true, runId: previous.run_id as string | null, command: null }
      const now = Date.now()
      this.db.prepare('INSERT OR IGNORE INTO conversations(key,adapter,channel,thread,team,author,cwd,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(input.key, input.adapter, input.channel, input.thread ?? null, input.team ?? null, input.author, cwd, now)
      const conversation = this.conversation(input.key)!
      // A room keeps its session even when its stable key originated in a DM.
      const resettable = input.adapter === 'cli' || (conversation.channel.startsWith('D') && /^slack:D[^:]*$/.test(input.key))
      if (conversation.state === 'idle' && !input.thread && resettable && now - conversation.updated_at > idleHours * 3600000) {
        this.db.prepare('UPDATE conversations SET session_id=NULL WHERE key=?').run(input.key)
      }
      const text = input.text.trim().toLowerCase()
      const command = ['stop', 'para', 'reset', 'nuevo'].includes(text) ? text : null
      const id = command ? null : randomUUID()
      this.db.prepare('INSERT INTO inbound VALUES(?,?,?)').run(input.adapter, input.eventId, id)
      this.db.prepare("UPDATE conversations SET author=?, updated_at=?, cwd=CASE WHEN cwd='' THEN ? ELSE cwd END, team=COALESCE(team,?) WHERE key=?")
        .run(input.author, now, cwd, input.team ?? null, input.key)
      if (id) {
        this.db.prepare('INSERT INTO runs(id,conversation_key,author,prompt,transcript,reply_thread,reply_channel,intent,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(id, input.key, input.author, redact(input.text), input.transcript ? redact(input.transcript) : null, input.replyThread ?? input.thread ?? null, input.channel, input.intent ?? 'ask', 'queued', now)
        const history = input.history ?? (input.adapter === 'slack' ? this.db.prepare('SELECT source FROM conversation_history WHERE conversation_key=?').get(input.key)?.source : undefined)
        if (history) {
          const source = typeof history === 'string' ? history : JSON.stringify(history)
          this.db.prepare('INSERT INTO run_history(run_id,source) VALUES(?,?)').run(id, source)
          if (input.history) this.db.prepare('INSERT INTO conversation_history VALUES(?,?) ON CONFLICT(conversation_key) DO UPDATE SET source=excluded.source')
            .run(input.key, JSON.stringify({ channel: input.history.channel, thread: input.history.thread }))
        }
        this.db.prepare("UPDATE gates SET state='answered',answer=? WHERE conversation_key=? AND state='pending'").run(redact(input.text), input.key)
        if (conversation.state !== 'running') this.state(input.key, 'queued')
      }
      if (switchContext && id) this.db.prepare('UPDATE conversations SET cwd=?,session_id=NULL WHERE key=?').run(cwd, input.key)
      return { duplicate: false, runId: id, command }
    })
  }
  state(key: string, state: string): void { this.db.prepare('UPDATE conversations SET state=? WHERE key=?').run(state, key) }
  session(key: string, id: string): void { this.db.prepare('UPDATE conversations SET session_id=? WHERE key=?').run(id, key) }
  queued(adapter?: string): Run[] {
    return this.db.prepare("SELECT r.* FROM runs r JOIN conversations c ON c.key=r.conversation_key WHERE r.state='queued' AND c.state='queued' AND (? IS NULL OR c.adapter=?) ORDER BY r.created_at,r.rowid").all(adapter ?? null, adapter ?? null) as unknown as Run[]
  }
  start(id: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE runs SET state='running',started_at=? WHERE id=? AND state='queued'").run(Date.now(), id)
      this.state(this.run(id)!.conversation_key, 'running')
    })
  }
  finish(id: string, state: string, result = '', error = '', acknowledge?: () => void): void {
    this.transaction(() => {
      this.db.prepare('UPDATE runs SET state=?,result=?,error=?,ended_at=? WHERE id=?').run(state, redact(result), redact(error), Date.now(), id)
      const key = this.run(id)!.conversation_key
      const pending = this.db.prepare("SELECT 1 FROM runs WHERE conversation_key=? AND state='queued'").get(key)
      const running = this.db.prepare("SELECT 1 FROM runs WHERE conversation_key=? AND state='running'").get(key)
      this.state(key, running ? 'running' : state === 'interrupted' ? 'interrupted' : state === 'waiting_human' ? 'waiting_human' : pending ? 'queued' : 'idle')
      this.db.prepare('UPDATE conversations SET updated_at=? WHERE key=?').run(Date.now(), key)
      acknowledge?.()
    })
  }
  event(id: string, kind: string, data: unknown): void {
    this.db.prepare('INSERT INTO events(run_id,kind,data,created_at) VALUES(?,?,?,?)').run(id, kind, redact(JSON.stringify(data)), Date.now())
  }
  recordUsage(id: string, cost: number, tokens: unknown): void {
    if (!Number.isFinite(cost) || cost < 0) throw new Error('Costo invalido en result de Claude.')
    this.transaction(() => {
      this.db.prepare('INSERT OR REPLACE INTO usage VALUES(?,?,?,?,?)').run(id, this.run(id)!.author, new Date().toISOString().slice(0, 10), cost, JSON.stringify(tokens))
      this.db.prepare('UPDATE runs SET cost=? WHERE id=?').run(cost, id)
    })
  }
  spent(author: string): number {
    return this.db.prepare('SELECT COALESCE(SUM(cost),0) AS cost FROM usage WHERE author=? AND day=?').get(author, new Date().toISOString().slice(0, 10))!.cost as number
  }
  recover(adapter?: string): Conversation[] {
    return this.transaction(() => {
      const affected = this.db.prepare("SELECT DISTINCT c.* FROM conversations c JOIN runs r ON c.key=r.conversation_key WHERE r.state='running' AND (? IS NULL OR c.adapter=?)").all(adapter ?? null, adapter ?? null) as unknown as Conversation[]
      for (const c of affected) {
        const run = this.db.prepare("SELECT reply_thread FROM runs WHERE conversation_key=? AND state='running' LIMIT 1").get(c.key)
        if (!c.thread) c.thread = run?.reply_thread as string | null
        this.db.prepare("UPDATE runs SET state='interrupted',error='Servidor reiniciado',ended_at=? WHERE conversation_key=? AND state='running'").run(Date.now(), c.key)
        this.state(c.key, 'interrupted')
      }
      return affected
    })
  }
  close(): void {
    if (this.ownsRuntime) this.db.prepare('DELETE FROM runtime WHERE owner=?').run(this.owner)
    this.db.close()
  }
}
