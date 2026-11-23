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
import { answerThread, THREAD_PROPOSAL_TTL_MS } from '../src/core/thread-proposals.ts'

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const done = (text) => ({ state: 'completed', text, cost: 0, usage: {}, error: '' })

const until = async (predicate) => {
  const limit = Date.now() + 5000

  while (!predicate()) {
    if (Date.now() > limit) throw new Error('Timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function init(repo) {
  fs.mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.name', 'Fixture')
  git(repo, 'config', 'user.email', 'fixture@example.test')
  fs.writeFileSync(path.join(repo, 'answer.txt'), 'original\n')
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/\n.worktrees/\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'Initial')
}

function fixture(t, { alerts } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-threads-')))
  const repo = path.join(root, 'repo')
  const other = path.join(root, 'other')
  const library = path.join(root, 'library')
  init(repo)
  init(other)
  init(library)
  git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', library, 'sub')
  git(repo, 'commit', '-m', 'Add submodule')

  const store = new Store(path.join(root, 'state.sqlite'))
  const notices = []
  const output = {
    async notice(c, text) {
      notices.push({ channel: c.channel, text })
    },
    async status() {},
    async delta() {},
    async finish() {},
  }
  const starts = []
  const config = ConfigSchema.parse({
    auth: { mode: 'indie' },
    repos: { path: root, default_repo: 'repo' },
    slack: {
      workspace_team_id: 'T1',
      allowed_users: ['U1', 'U2'],
      ...(alerts ? { alerts_channel: alerts } : {}),
    },
    mcp: { enabled: true, principals: [{ id: 'fixture', token_env: 'REGENT_MCP_TOKEN_FIXTURE' }] },
  })
  const core = new Core({
    store,
    config,
    cwd: root,
    output,
    runner: (opts) => {
      let finish
      const controller = {
        opts,
        done: new Promise((resolve) => {
          finish = resolve
        }),
        finish: (text = 'result') => finish(done(text)),
        cancel: () => finish(done('cancelled')),
      }
      starts.push(controller)
      opts.onEvent({ kind: 'init', sessionId: opts.sessionId ?? randomUUID() })
      return controller
    },
  })
  const threads = {
    proposals: [],
    opened: [],
    settled: [],
    whispers: [],
    async propose(c, proposal) {
      this.proposals.push({ c, proposal })
      return `proposal-${this.proposals.length}`
    },
    async open(channel, text) {
      this.opened.push({ channel, text })
      return `thread-${this.opened.length}`
    },
    async permalink(channel, ts) {
      return `https://slack.test/${channel}/${ts}`
    },
    async settle(channel, ts, text) {
      this.settled.push({ ts, text })
    },
    async whisper(channel, thread, user, text) {
      this.whispers.push(text)
    },
  }
  core.threads = threads

  t.after(async () => {
    for (const run of starts) run.finish()
    await core.close()
    store.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  const submit = async (text, { key = 'conversation', author = 'U1', adapter = 'slack' } = {}) => {
    const before = starts.length
    const accepted = await core.submit({
      adapter,
      eventId: randomUUID(),
      key,
      author: adapter === 'mcp' ? 'mcp:fixture' : author,
      team: 'T1',
      channel: 'C1',
      text,
    })
    if (accepted.runId) await until(() => starts.length > before && core.active.has(key))
    return accepted
  }

  const finish = async (key = 'conversation', text) => {
    starts.at(-1).finish(text)
    await until(() => !core.active.has(key))
  }

  const propose = (repoName, key = 'conversation') => {
    const active = core.active.get(key)
    return core.tool(active.token, 'regent_propose_thread', {
      repo: repoName,
      summary: `Seguir con ${repoName}: agregar la vista de metas.`,
    })
  }

  const answer = (id, open, user = 'U1') =>
    answerThread(core, { id, open, user, team: 'T1', channel: 'C1' })

  const proposal = (key = 'conversation') => store.threadProposals(key)[0]

  return {
    root,
    repo,
    other,
    store,
    core,
    threads,
    notices,
    starts,
    submit,
    finish,
    propose,
    answer,
    proposal,
  }
}

test('the agent proposes a thread for an independent project and the run waits', async (t) => {
  const f = fixture(t)
  await f.submit('Ahora quiero cambiar el proyecto other')
  const result = await f.propose('other')

  assert.equal(result.waiting_human, true)
  assert.match(result.instruction, /only if the requester presses/)
  assert.equal(f.threads.proposals.length, 1)
  assert.deepEqual(
    {
      project: f.threads.proposals[0].proposal.project,
      current: f.threads.proposals[0].proposal.current,
    },
    { project: 'other', current: 'repo' },
  )
  await until(() => !f.core.active.has('conversation'))
  assert.equal(f.store.conversation('conversation').state, 'waiting_human')
  assert.equal(f.threads.opened.length, 0, 'nothing opens before the requester confirms')
  assert.equal(f.proposal().state, 'pending')
  assert.equal(f.proposal().message_ts, 'proposal-1')
})

test('submodules, services, worktrees and unknown repositories never get a thread', async (t) => {
  const f = fixture(t)
  await f.submit('Cambia el submodulo')

  for (const target of ['repo/sub', 'repo', path.join(f.repo, 'sub')]) {
    await assert.rejects(f.propose(target), /parte de este mismo proyecto/, target)
  }

  fs.mkdirSync(path.join(f.repo, '.worktrees'), { recursive: true })
  git(f.repo, 'worktree', 'add', '-q', '-b', 'scratch', path.join(f.repo, '.worktrees', 'scratch'))
  await assert.rejects(f.propose('repo/.worktrees/scratch'), /parte de este mismo proyecto/)
  await assert.rejects(f.propose('missing'), /No encontre el proyecto/)
  assert.equal(f.threads.proposals.length, 0)
  await f.finish()
})

test('only the requester can confirm, and a double click opens one thread', async (t) => {
  const f = fixture(t)
  await f.submit('Cambia other')
  await f.propose('other')
  await until(() => !f.core.active.has('conversation'))
  const { id } = f.proposal()

  await assert.rejects(f.answer(id, true, 'U2'), /Solo <@U1> puede decidir/)
  assert.equal(f.threads.opened.length, 0)

  const [first, second] = await Promise.all([f.answer(id, true), f.answer(id, true)])
  assert.deepEqual([first.duplicate, second.duplicate].sort(), [false, true])
  assert.equal(f.threads.opened.length, 1)
  assert.match(f.threads.opened[0].text, /<@U1> Hilo para trabajar en \*other\*/)
  assert.match(f.threads.opened[0].text, /https:\/\/slack\.test\/C1\/proposal-1/)

  const key = 'slack:C1:thread-1'
  await until(() => f.core.active.has(key))
  const opened = f.store.conversation(key)
  assert.equal(opened.cwd, f.other)
  assert.equal(opened.thread, 'thread-1')
  assert.match(
    f.store.run(f.core.active.get(key).run.id).prompt,
    /Seguir con other: agregar la vista de metas/,
  )
  await until(() => f.proposal().state === 'opened')
  assert.match(
    f.threads.settled.at(-1).text,
    /Abri el hilo para other: https:\/\/slack\.test\/C1\/thread-1/,
  )
  assert.equal(f.store.conversation('conversation').state, 'idle')
  await f.finish(key)
})

test('a project whose thread exists returns its link instead of a second thread', async (t) => {
  const f = fixture(t)
  await f.submit('Cambia other')
  await f.propose('other')
  await until(() => !f.core.active.has('conversation'))
  await f.answer(f.proposal().id, true)
  await until(() => f.core.active.has('slack:C1:thread-1'))
  await f.finish('slack:C1:thread-1')

  await f.submit('Y otra cosa en other')
  const again = await f.propose('other')
  assert.equal(again.existing_thread, 'https://slack.test/C1/thread-1')
  assert.equal(f.threads.proposals.length, 1)
  await f.finish()
})

test('one pending proposal at a time, and a text answer does not open the thread', async (t) => {
  const f = fixture(t)
  init(path.join(f.root, 'third'))
  await f.submit('Cambia other')
  await f.propose('other')
  await until(() => !f.core.active.has('conversation'))

  await f.submit('sí, ábrelo')
  assert.equal(f.threads.opened.length, 0, 'text never opens a thread')
  assert.equal(f.proposal().state, 'pending')
  await assert.rejects(f.propose('third'), /Ya hay una propuesta de hilo pendiente para other/)
  const repeat = await f.propose('other')
  assert.equal(repeat.waiting_human, true)
  assert.equal(f.threads.proposals.length, 1, 'the pending proposal is reused, not posted again')
  await until(() => !f.core.active.has('conversation'))
})

test('choosing to stay resumes the thread and the agent cannot insist in that turn', async (t) => {
  const f = fixture(t)
  await f.submit('Cambia other')
  await f.propose('other')
  await until(() => !f.core.active.has('conversation'))
  const { id } = f.proposal()

  const declined = await f.answer(id, false)
  assert.equal(declined.duplicate, false)
  assert.equal(f.threads.settled.at(-1).text, 'Seguimos en este hilo.')
  await until(() => f.core.active.has('conversation'))
  assert.match(
    f.store.run(f.core.active.get('conversation').run.id).prompt,
    /prefirio seguir en este hilo/,
  )
  await assert.rejects(f.propose('other'), /eligio seguir en este hilo/)
  await f.finish()

  await f.submit('Ahora sí, abre el hilo de other')
  const asked = await f.propose('other')
  assert.equal(asked.waiting_human, true, 'a later request from the user may propose again')
  assert.equal((await f.answer(id, true)).duplicate, true, 'the old proposal stays decided')
  await until(() => !f.core.active.has('conversation'))
})

test('an expired proposal cannot be confirmed', async (t) => {
  const f = fixture(t)
  await f.submit('Cambia other')
  await f.propose('other')
  await until(() => !f.core.active.has('conversation'))
  const { id } = f.proposal()
  f.store.db
    .prepare('UPDATE thread_proposals SET created_at=? WHERE id=?')
    .run(Date.now() - THREAD_PROPOSAL_TTL_MS - 1, id)

  await assert.rejects(f.answer(id, true), /vencio/)
  assert.equal(f.threads.opened.length, 0)
  assert.equal(f.proposal().state, 'failed')
})

test('MCP conversations use regent_start instead of a thread', async (t) => {
  const f = fixture(t)
  await f.submit('Cambia other', { adapter: 'mcp' })
  await assert.rejects(f.propose('other'), /solo existe en Slack/)
  await f.finish()
})

test('a requester selecting another project in the thread gets the same confirmation', async (t) => {
  const f = fixture(t)
  await f.submit('Hola')
  await f.finish()
  const runs = f.starts.length

  const eventId = randomUUID()
  const input = {
    adapter: 'slack',
    eventId,
    key: 'conversation',
    author: 'U1',
    team: 'T1',
    channel: 'C1',
    text: 'repo: other\nagrega la vista de metas',
  }
  const accepted = await f.core.submit(input)
  assert.equal(accepted.runId, null)
  assert.equal(f.starts.length, runs, 'no run starts for the selection')
  assert.equal(f.threads.proposals.length, 1)
  assert.equal(f.proposal().summary, 'agrega la vista de metas')
  assert.equal((await f.core.submit(input)).duplicate, true)
  assert.equal(f.threads.proposals.length, 1)

  const same = await f.submit('repo: repo/sub\nrevisa el submodulo')
  assert.ok(same.runId, 'a submodule of the same project stays in this thread')
  assert.equal(f.threads.proposals.length, 1)
  await f.finish()
})

test('a run that leaves the shared checkout modified raises an alert', async (t) => {
  const f = fixture(t, { alerts: 'CALERT' })
  fs.writeFileSync(path.join(f.repo, 'already-there.txt'), 'untracked before the run\n')
  await f.submit('Responde algo')
  const active = f.core.active.get('conversation')
  await new Promise((resolve) => setTimeout(resolve, 100))
  fs.writeFileSync(path.join(f.repo, 'answer.txt'), 'changed in the shared checkout\n')
  fs.mkdirSync(path.join(f.repo, '.worktrees', 'own'), { recursive: true })
  fs.writeFileSync(path.join(f.repo, '.worktrees', 'own', 'file.txt'), 'ignored\n')
  await f.finish()
  await active.sharedCheck

  const event = f.store.db
    .prepare("SELECT data FROM events WHERE run_id=? AND kind='shared_checkout_changed'")
    .get(active.run.id)
  assert.deepEqual(JSON.parse(event.data).files, [' M answer.txt'])
  const alert = f.notices.find((notice) => notice.channel === 'CALERT')
  assert.match(alert.text, /carpeta compartida/)
  assert.match(alert.text, / M answer\.txt/)
})

test('a run that leaves the shared checkout as it found it raises nothing', async (t) => {
  const f = fixture(t, { alerts: 'CALERT' })
  fs.writeFileSync(path.join(f.repo, 'answer.txt'), 'dirty before the run\n')
  await f.submit('Responde algo')
  const active = f.core.active.get('conversation')
  await f.finish()
  await active.sharedCheck

  const events = f.store.db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE run_id=? AND kind='shared_checkout_changed'")
    .get(active.run.id)
  assert.equal(events.n, 0)
  assert.equal(f.notices.filter((notice) => notice.channel === 'CALERT').length, 0)
})

test('the shared-checkout check only reads, so it never holds the index lock', async (t) => {
  const { sharedCheckoutEntries } = await import('../src/core/shared-checkout.ts')
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-status-')))
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  init(repo)
  const index = path.join(repo, '.git', 'index')
  const indexBefore = fs.statSync(index).mtimeMs
  // Same content, newer timestamp: a plain status would refresh and rewrite the index.
  const future = new Date(Date.now() + 60000)
  fs.utimesSync(path.join(repo, 'answer.txt'), future, future)

  assert.deepEqual([...(await sharedCheckoutEntries(repo))], [])
  assert.equal(fs.statSync(index).mtimeMs, indexBefore)
  git(repo, 'status', '--porcelain')
  assert.notEqual(fs.statSync(index).mtimeMs, indexBefore, 'a plain status does rewrite it')
})

test('Slack shows two buttons in the thread and opens the new thread at the channel level', async () => {
  const { createThreadApi, THREAD_OPEN_ACTION, THREAD_STAY_ACTION } = await import(
    '../src/adapters/slack/threads.ts'
  )
  const calls = []
  const api = async (method, args) => {
    calls.push({ method, args })
    return { ts: `ts-${calls.length}`, permalink: 'https://slack.test/link' }
  }
  const threads = createThreadApi(api)
  const conversation = { channel: 'C1', thread: '100.1' }

  const ts = await threads.propose(conversation, {
    id: 'abc',
    project: 'other',
    current: 'repo',
    summary: 'Seguir con la vista',
  })
  assert.equal(ts, 'ts-1')
  const proposal = calls[0].args
  assert.equal(proposal.thread_ts, '100.1', 'the proposal stays in the current thread')
  const buttons = proposal.blocks.find((block) => block.type === 'actions').elements
  assert.deepEqual(
    buttons.map((button) => [button.action_id, button.value]),
    [
      [THREAD_OPEN_ACTION, 'abc'],
      [THREAD_STAY_ACTION, 'abc'],
    ],
  )

  await threads.open('C1', 'Hilo para other')
  assert.equal(calls[1].method, 'chat.postMessage')
  assert.equal(calls[1].args.thread_ts, undefined, 'the new thread starts at the channel level')
  assert.equal(await threads.permalink('C1', 'ts-2'), 'https://slack.test/link')
})
