import type { DatabaseSync } from 'node:sqlite'

/** Highest `PRAGMA user_version` this server understands. Bump it with every new migration. */
export const SCHEMA_VERSION = 12

const BASE_SCHEMA = `
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
`

interface Migration {
  version: number
  apply(db: DatabaseSync): void
}

const sql =
  (statements: string) =>
  (db: DatabaseSync): void =>
    db.exec(statements)

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column)
}

/** Applied in order on databases older than their version. Never edit a shipped entry. */
const MIGRATIONS: Migration[] = [
  {
    version: 2,
    apply: sql(`
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
    `),
  },
  {
    version: 3,
    apply: sql(`
      ALTER TABLE gates ADD COLUMN question_id TEXT;
      ALTER TABLE gates ADD COLUMN options TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE gates ADD COLUMN destination TEXT;
      CREATE UNIQUE INDEX gates_question_id ON gates(question_id);
    `),
  },
  {
    version: 4,
    apply: sql(`
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, conversation_key TEXT NOT NULL, command TEXT NOT NULL, cwd TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', requested_by TEXT NOT NULL, actor TEXT,
        conversation TEXT NOT NULL, created_at INTEGER NOT NULL, decided_at INTEGER
      );
    `),
  },
  {
    version: 5,
    apply: sql(`
      CREATE TABLE IF NOT EXISTS conversation_history (conversation_key TEXT PRIMARY KEY, source TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_history (run_id TEXT PRIMARY KEY REFERENCES runs(id), source TEXT NOT NULL, snapshot TEXT);
      CREATE TABLE IF NOT EXISTS history_seen (conversation_key TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL, hash TEXT NOT NULL,
        PRIMARY KEY(conversation_key,session_id,message_id));
    `),
  },
  {
    version: 6,
    apply: sql(`
      CREATE TABLE IF NOT EXISTS room_transfers (
        conversation_key TEXT PRIMARY KEY REFERENCES conversations(key), name TEXT NOT NULL UNIQUE,
        channel TEXT UNIQUE, origin TEXT NOT NULL, summary TEXT NOT NULL, users TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending'
      );
    `),
  },
  {
    version: 7,
    apply: sql(
      'CREATE TABLE IF NOT EXISTS slack_progress (run_id TEXT PRIMARY KEY, channel TEXT NOT NULL, ts TEXT NOT NULL);',
    ),
  },
  {
    version: 8,
    apply: sql(
      'CREATE TABLE IF NOT EXISTS activity_progress (run_id TEXT PRIMARY KEY, data TEXT NOT NULL);',
    ),
  },
  {
    version: 9,
    apply: sql(
      'CREATE TABLE IF NOT EXISTS slack_finish (run_id TEXT NOT NULL, page INTEGER NOT NULL, channel TEXT NOT NULL, ts TEXT NOT NULL, PRIMARY KEY(run_id,page));',
    ),
  },
  {
    version: 10,
    apply: sql(`
      CREATE TABLE IF NOT EXISTS oauth_clients (id TEXT PRIMARY KEY, metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_sessions (
        id TEXT PRIMARY KEY, author TEXT NOT NULL, identity TEXT NOT NULL,
        client_id TEXT NOT NULL REFERENCES oauth_clients(id), resource TEXT NOT NULL,
        expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        hash TEXT PRIMARY KEY, kind TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES oauth_sessions(id),
        expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS oauth_sessions_author ON oauth_sessions(author);
      CREATE INDEX IF NOT EXISTS oauth_tokens_session ON oauth_tokens(session_id);
    `),
  },
  {
    version: 11,
    apply: sql(`
      CREATE TABLE IF NOT EXISTS previews (
        id TEXT PRIMARY KEY, conversation_key TEXT NOT NULL UNIQUE,
        port INTEGER NOT NULL UNIQUE, cwd TEXT NOT NULL, pid INTEGER,
        process_start TEXT, expires_at INTEGER NOT NULL
      );
    `),
  },
  {
    version: 12,
    apply(db) {
      // Some early databases got this column outside a numbered migration.
      if (!hasColumn(db, 'conversations', 'session_cwd')) {
        db.exec('ALTER TABLE conversations ADD COLUMN session_cwd TEXT;')
      }
    },
  },
]

/** Creates the base tables and brings an older database up to SCHEMA_VERSION. Call inside a transaction. */
export function migrate(db: DatabaseSync): void {
  const version = db.prepare('PRAGMA user_version').get()!.user_version as number

  if (version > SCHEMA_VERSION) {
    throw new Error(`Esquema SQLite ${version} mas nuevo que este servidor.`)
  }

  db.exec(BASE_SCHEMA)

  for (const migration of MIGRATIONS) {
    if (version >= migration.version) continue
    migration.apply(db)
    db.exec(`PRAGMA user_version=${migration.version};`)
  }
}
