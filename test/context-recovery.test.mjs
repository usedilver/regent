import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Store } from '../src/storage/store.ts'
import { Core } from '../src/core/core.ts'
import { ConfigSchema } from '../src/config.ts'
import { History, HISTORY_CONTEXT_CHARS } from '../src/core/history.ts'
import { gatherHistory } from '../src/adapters/slack/adapter.ts'
import { executionFailure, failureMessage } from '../src/execution/failures.ts'
import { startRunner } from '../src/execution/runner.ts'
import { queryDenial } from '../plugins/executor/hooks/query.mjs'
import { ExternalMcp } from '../src/adapters/mcp/server.ts'
import { isolationFor } from '../src/core/repository.ts'

const key = 'slack:C:1'
const input = (id, text = 'Explica el código') => ({
  adapter: 'slack',
  eventId: id,
  key,
  channel: 'C',
  thread: '1',
  author: 'U',
  team: 'T',
  text,
  history: { channel: 'C', thread: '1', latest: id, trigger: `C:${id}` },
})
const until = async (predicate) => {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
const success = () => ({
  state: 'completed',
  text: 'Verificado',
  error: '',
  cost: 0.3,
  usage: { input_tokens: 50 },
})
const overflow = () => ({
  state: 'failed',
  text: 'Prompt is too long',
  error: 'Claude termino con codigo 1',
  cost: 0.2,
  usage: { input_tokens: 100 },
})
function fixture(t, execute = async () => success(), editing = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-context-')))
  const git = (...args) =>
    execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-b', 'main')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  fs.writeFileSync(path.join(root, '.gitignore'), '.claude/\n.env\n')
  fs.writeFileSync(path.join(root, 'work.txt'), 'original')
  git('add', '.')
  git('commit', '-m', 'Initial')
  fs.writeFileSync(path.join(root, '.env'), 'SYNTHETIC_PROJECT_VALUE=preserved\n')
  const store = new Store(':memory:')
  const config = ConfigSchema.parse({
    auth: { mode: 'indie' },
    repos: { path: root },
    slack: { workspace_team_id: 'T', allowed_users: ['U'] },
  })
  const messages = [],
    starts = []
  const core = new Core({
    store,
    config,
    cwd: root,
    output: Object.fromEntries(
      ['notice', 'status', 'delta', 'finish'].map((kind) => [
        kind,
        async (...args) => {
          messages.push({ kind, args })
        },
      ]),
    ),
    runnerOverrides: { timeoutMs: 1000, maxCost: 1 },
    runner: (opts) => {
      starts.push(opts)
      opts.onEvent({ kind: 'init', sessionId: opts.sessionId ?? `fresh-${starts.length}` })
      return { done: Promise.resolve().then(() => execute(opts, starts.length)), cancel() {} }
    },
  })
  const seed = store.accept(input('seed', 'Objetivo original autorizado'), root, 24)
  store.finish(seed.runId, 'completed', 'Decisión previa: conservar el trabajo existente.')
  const isolation = isolationFor(root, key)
  if (editing) {
    git('worktree', 'add', '-b', isolation.name, isolation.dir, 'HEAD')
    fs.writeFileSync(path.join(isolation.dir, 'work.txt'), 'cambio existente')
  }
  store.session(key, 'old-session', editing ? isolation.dir : root)
  core.historyLoader = async () => [
    { id: 'C:prior', text: 'Requisito previo importante' },
    { id: 'C:next', text: 'Explica el código' },
  ]
  t.after(async () => {
    await core.close()
    store.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, store, core, starts, messages, isolation, git, editing }
}
const submit = async (f) => {
  const accepted = await f.core.submit(
    input('next', f.editing ? 'Corrige el footer de la aplicación' : 'Explica el código'),
  )
  await until(() => !f.core.active.size)
  return f.store.run(accepted.runId)
}

test('delivered Slack history exceeding 200000 characters does not block a small follow-up', async () => {
  const store = new Store(':memory:')
  try {
    const messages = []
    for (let batch = 0; batch < 6; batch++) {
      for (let i = 0; i < 10; i++)
        messages.push({ id: `C:${batch * 10 + i}`, text: 'x'.repeat(4000) })
      const run = store.accept(input(`batch-${batch}`), '/tmp', 24)
      const history = await new History(store).prepare(
        run.runId,
        key,
        batch ? 'session' : null,
        async () => messages,
      )
      history.acknowledge('session')
    }
    messages.push({ id: 'C:last', text: 'n'.repeat(2000) })
    const run = store.accept(input('last', 'n'.repeat(2000)), '/tmp', 24)
    const history = await new History(store).prepare(
      run.runId,
      key,
      'session',
      async () => messages,
    )
    assert.ok(JSON.stringify(messages).length > 200000)
    assert.equal(history.omitted, 0)
    assert.ok(history.text.length < 4000)
    history.acknowledge('session')
    assert.equal(store.db.prepare('select count(*) as n from history_seen').get().n, 61)
  } finally {
    store.close()
  }
})

test('large initial history is bounded, remains readable and does not acknowledge omitted content', async () => {
  const store = new Store(':memory:')
  try {
    const messages = [
      { id: 'C:large', text: 'older requirement '.repeat(18000) },
      { id: 'C:new', text: 'recent requirement' },
      { id: 'C:request', text: 'actual request' },
    ]
    const run = store.accept(input('request'), '/tmp', 24)
    const history = await new History(store).prepare(run.runId, key, null, async () => messages)
    assert.ok(history.text.length < HISTORY_CONTEXT_CHARS + 1000)
    assert.match(history.text, /recent requirement/)
    assert.match(history.text, /regent_read_history/)
    history.acknowledge('new-session')
    assert.equal(
      store.db.prepare("select count(*) as n from history_seen where message_id='C:large'").get().n,
      0,
    )
    const expected = messages.map((m) => `[${m.id}] ${m.text}`).join('\n\n')
    let offset = 0,
      full = ''
    do {
      const page = new History(store).read(run.runId, offset, 4096)
      assert.ok(page.text.length <= 4096)
      full += page.text
      offset = page.next_offset
    } while (offset !== null)
    assert.equal(full, expected)
  } finally {
    store.close()
  }
})

test('Slack retrieval accepts more than 2000 messages while still detecting pagination failures', async () => {
  const rows = Array.from({ length: 2101 }, (_, i) => ({
    ts: String(i + 1),
    user: 'U',
    text: `message-${i}`,
  }))
  const messages = await gatherHistory(
    async (_method, args) => {
      const offset = Number(args.cursor ?? 0),
        next = offset + 100
      return {
        messages: rows.slice(offset, next),
        response_metadata: { next_cursor: next < rows.length ? String(next) : '' },
      }
    },
    { channel: 'C', thread: '1', latest: '9999' },
    'BOT',
    async () => '',
  )
  assert.equal(messages.length, 2101)
  assert.match(messages.at(-1).text, /message-2100/)
})

test('known quota/authentication/rate failures take priority over their compaction wrapper', () => {
  for (const [detail, code] of [
    [
      "Prompt is too long · automatic compaction failed: You've hit your session limit · resets 6pm (UTC)",
      'usage_limit',
    ],
    ['Prompt is too long · automatic compaction failed: authentication_error', 'authentication'],
    ['Prompt is too long · automatic compaction failed: 429 rate_limit_error', 'rate_limit'],
    ['Prompt is too long · automatic compaction failed: upstream unavailable', 'compaction_failed'],
    ['Prompt is too long', 'context_window'],
    ['error_max_budget_usd', 'run_budget'],
  ])
    assert.equal(executionFailure(detail).code, code)
  const message = failureMessage(
    executionFailure("You've hit your session limit · resets 6pm (UTC)"),
  )
  assert.match(message, /cuota de uso/)
  assert.match(message, /6pm \(UTC\)/)
  assert.equal(executionFailure('A different execution failure'), undefined)
  assert.equal(executionFailure('ENOENT: /project/context-window.ts:429:401'), undefined)
  assert.equal(executionFailure('API Error: 429 upstream limited requests').code, 'rate_limit')
  assert.equal(executionFailure('HTTP 401: authorization rejected').code, 'authentication')
})

test('runner preserves an error result with subtype success and exit code 1', async () => {
  const script = `console.log(JSON.stringify({type:'system',subtype:'init',session_id:'test',mcp_servers:[]}));console.log(JSON.stringify({type:'result',subtype:'success',is_error:true,result:"Prompt is too long · automatic compaction failed: You've hit your session limit · resets 6pm (UTC)",errors:[]}));process.exitCode=1`
  const result = await startRunner({
    cwd: os.tmpdir(),
    prompt: 'fixture',
    runId: 'fixture',
    command: process.execPath,
    prefixArgs: ['-e', script, '--'],
    token: 'synthetic',
    toolsUrl: 'http://127.0.0.1:1/tools',
    readonlyMcp: [],
    timeoutMs: 2000,
    stallMs: 1000,
    graceMs: 20,
    onEvent() {},
  }).done
  assert.equal(result.state, 'failed')
  assert.equal(result.failure.code, 'usage_limit')
  assert.match(result.error, /session limit/)
  assert.doesNotMatch(result.error, /^Claude termino con codigo 1$/)
})

for (const editing of [false, true])
  test(`context recovery preserves ${editing ? 'an existing dirty worktree' : 'query mode'}, deadlines, costs and conversation`, async (t) => {
    const f = fixture(
      t,
      async (_opts, n) => {
        if (n === 1) {
          await new Promise((resolve) => setTimeout(resolve, 25))
          return overflow()
        }
        return success()
      },
      editing,
    )
    const run = await submit(f)
    assert.equal(run.state, 'completed')
    assert.equal(f.starts.length, 2)
    const [first, second] = f.starts
    assert.equal(first.sessionId, 'old-session')
    assert.equal(second.sessionId, null)
    assert.equal(second.runId, first.runId)
    assert.equal(second.readOnly, !editing)
    assert.equal(second.worktreeName, first.worktreeName)
    assert.equal(second.cwd, first.cwd)
    assert.equal(second.env.SYNTHETIC_PROJECT_VALUE, 'preserved')
    assert.ok(second.timeoutMs < first.timeoutMs)
    assert.equal(second.maxCost, 0.8)
    assert.match(second.prompt, /Decisión previa/)
    assert.match(second.prompt, /Requisito previo/)
    assert.equal(f.store.conversation(key).session_id, 'fresh-2')
    assert.equal(f.store.conversation(key).session_cwd, editing ? f.isolation.dir : f.root)
    assert.equal(run.cost, 0.5)
    assert.equal(
      JSON.parse(f.store.db.prepare('select tokens from usage where run_id=?').get(run.id).tokens)
        .input_tokens,
      150,
    )
    assert.equal(f.messages.filter((m) => m.kind === 'finish').length, 1)
    if (editing)
      assert.equal(
        fs.readFileSync(path.join(f.isolation.dir, 'work.txt'), 'utf8'),
        'cambio existente',
      )
    else assert.ok(!fs.existsSync(f.isolation.dir))
  })

test('quota failures never retry or clear the session and explain the reset time', async (t) => {
  const f = fixture(t, async () => ({
    ...overflow(),
    text: "Prompt is too long · automatic compaction failed: You've hit your session limit · resets 6pm (UTC)",
  }))
  const run = await submit(f)
  assert.equal(f.starts.length, 1)
  assert.equal(run.state, 'failed')
  assert.equal(f.store.conversation(key).session_id, 'old-session')
  const reply = f.messages.find((m) => m.kind === 'finish').args[2]
  assert.match(reply, /cuota de uso/)
  assert.match(reply, /6pm \(UTC\)/)
  assert.doesNotMatch(reply, /Respuesta parcial/)
})

test('context recovery is attempted only once, then leaves a clear resumable failure', async (t) => {
  const f = fixture(t, async () => overflow())
  const run = await submit(f)
  assert.equal(f.starts.length, 2)
  assert.equal(run.state, 'failed')
  assert.equal(f.store.conversation(key).session_id, null)
  assert.match(f.messages.find((m) => m.kind === 'finish').args[2], /ventana de contexto/)
})

test('context failure after a tool preserves edits and waits for another human message', async (t) => {
  const f = fixture(
    t,
    async (opts, n) => {
      if (n === 1) {
        opts.onEvent({ kind: 'tool_use', id: 'write', name: 'Edit', input: {} })
        fs.writeFileSync(path.join(f.isolation.dir, 'work.txt'), 'trabajo parcial')
        return overflow()
      }
      return success()
    },
    true,
  )
  const run = await submit(f)
  assert.equal(run.state, 'failed')
  assert.equal(f.starts.length, 1)
  assert.equal(fs.readFileSync(path.join(f.isolation.dir, 'work.txt'), 'utf8'), 'trabajo parcial')
  assert.equal(f.store.conversation(key).session_id, null)
  await f.core.submit(input('continue', 'Continúa'))
  await until(() => !f.core.active.size)
  assert.equal(f.starts.length, 2)
  assert.equal(f.starts[1].sessionId, null)
  assert.equal(fs.readFileSync(path.join(f.isolation.dir, 'work.txt'), 'utf8'), 'trabajo parcial')
})

test('access withdrawal between attempts prevents automatic execution', async (t) => {
  const f = fixture(t, async () => {
    f.core.access.replace({ slack: { allowed_users: ['OTHER'] } })
    return overflow()
  })
  await submit(f)
  assert.equal(f.starts.length, 1)
})

test('history reader is read-only, paged, scoped to the active run and expires with it', async (t) => {
  let release
  const f = fixture(
    t,
    async () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const other = f.store.accept({ ...input('other'), key: 'other-conversation' }, f.root, 24)
  f.store.db
    .prepare('update run_history set snapshot=? where run_id=?')
    .run(JSON.stringify([{ id: 'PRIVATE', text: 'unrelated-data' }]), other.runId)
  f.store.finish(other.runId, 'completed')
  await f.core.submit(input('next'))
  await until(() => release)
  const active = [...f.core.active.values()][0]
  assert.equal(queryDenial({ tool_name: 'mcp__regent__regent_read_history' }), null)
  const page = await f.core.tool(active.token, 'regent_read_history', {
    max_chars: 12,
    run_id: other.runId,
  })
  assert.equal(page.text.length, 12)
  assert.ok(page.next_offset > 0)
  const all = await f.core.tool(active.token, 'regent_read_history', {})
  assert.match(all.text, /Requisito previo/)
  assert.doesNotMatch(all.text, /unrelated-data/)
  await assert.rejects(f.core.tool(active.token, 'regent_read_history', { max_chars: 16001 }))
  release(success())
  await until(() => !f.core.active.size)
  await assert.rejects(f.core.tool(active.token, 'regent_read_history', {}), /terminado/)
})

test('Slack history failures are distinguished from Claude context failures', async (t) => {
  const f = fixture(t)
  f.core.historyLoader = async () => {
    throw new Error('missing_scope')
  }
  const run = await submit(f)
  assert.equal(f.starts.length, 0)
  assert.equal(run.state, 'failed')
  const reply = f.messages.find((m) => m.kind === 'finish').args[2]
  assert.match(reply, /historial de Slack/)
  assert.match(reply, /missing_scope/)
  const event = JSON.parse(
    f.store.db
      .prepare("select data from events where run_id=? and kind='execution_failure'")
      .get(run.id).data,
  )
  assert.equal(event.source, 'slack')
  assert.equal(event.code, 'history_unavailable')
})

test('recovery does not exceed its budget or reset the original deadline', async (t) => {
  const f = fixture(t, async () => ({ ...overflow(), cost: 1 }))
  await submit(f)
  assert.equal(f.starts.length, 1)
  assert.equal(f.store.spent('U'), 1)
})

test('a user stop arriving before a context failure prevents automatic recovery', async (t) => {
  let release
  const f = fixture(
    t,
    async () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  await f.core.submit(input('next'))
  await until(() => release)
  await f.core.submit(input('stop', 'stop'))
  release(overflow())
  await until(() => !f.core.active.size)
  assert.equal(f.starts.length, 1)
  assert.equal(f.store.conversation(key).state, 'interrupted')
})

test('a fresh execution that cannot fit does not restart itself in a loop', async (t) => {
  const f = fixture(t, async () => overflow())
  f.store.db
    .prepare('update conversations set session_id=NULL,session_cwd=NULL where key=?')
    .run(key)
  await submit(f)
  assert.equal(f.starts.length, 1)
  assert.match(f.messages.find((m) => m.kind === 'finish').args[2], /contexto inicial/)
})

test('MCP status exposes a classified failure, without retaining it after successful recovery', async (t) => {
  const f = fixture(t)
  const accepted = f.store.accept(
    {
      ...input('mcp'),
      adapter: 'mcp',
      author: 'mcp:fixture',
      key: 'mcp-conversation',
      history: undefined,
    },
    f.root,
    24,
  )
  const failure = executionFailure(
    "Prompt is too long · automatic compaction failed: You've hit your session limit · resets 6pm (UTC)",
  )
  f.store.event(accepted.runId, 'execution_failure', failure)
  f.store.finish(accepted.runId, 'failed', failure.detail, 'provider failure')
  f.core.config.mcp.enabled = true
  f.core.config.mcp.principals = [{ id: 'fixture', token_env: 'REGENT_MCP_TOKEN_FIXTURE' }]
  const gateway = new ExternalMcp(f.core, {
    REGENT_MCP_TOKEN_FIXTURE: 'synthetic-token-only-for-fixtures-1234567890',
  })
  const status = gateway.status('mcp:fixture', accepted.runId)
  assert.equal(status.run.failure.code, 'usage_limit')
  assert.equal(status.run.failure.source, 'claude')
  assert.match(status.run.failure.message, /cuota de uso/)
  f.store.finish(accepted.runId, 'completed', 'recovered')
  assert.equal(gateway.status('mcp:fixture', accepted.runId).run.failure, undefined)
})

test('history loading observes the original deadline even when its loader never resolves', async (t) => {
  const f = fixture(t)
  f.core.runnerOverrides.timeoutMs = 100
  f.core.historyLoader = async () => new Promise(() => {})
  const started = Date.now()
  const run = await submit(f)
  assert.equal(f.starts.length, 0)
  assert.equal(run.state, 'interrupted')
  assert.ok(Date.now() - started < 1000)
  assert.match(f.messages.find((m) => m.kind === 'finish').args[2], /tiempo máximo/)
})
