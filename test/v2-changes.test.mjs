import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { once } from 'node:events'
import { Store } from '../src/v2/store.ts'
import { ConfigSchema } from '../src/v2/config.ts'
import { Changes, command, parseNumstat, smallFix } from '../src/v2/changes.ts'
import { Tasks } from '../src/v2/tasks.ts'
import { NotionTracker } from '../src/v2/tracker.ts'
import { Effects } from '../src/v2/effects.ts'
import { Core } from '../src/v2/core.ts'
import { createHttp } from '../src/v2/http.ts'
import { SlackOutput } from '../src/v2/slack.ts'
import { upsertSection, upsertPlan } from '../src/notion-sections.ts'

let failed = 0
const check = async (name, fn) => { try { await fn(); console.log(`  OK ${name}`) } catch (error) { failed++; console.error(`  FAIL ${name}: ${error.stack}`) } }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'regent-changes-'))
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const key = 'slack:C1:1'
function fixture() {
  const dir = fs.mkdtempSync(path.join(root, 'case-')), repo = path.join(dir, 'repo'), remote = path.join(dir, 'remote.git')
  fs.mkdirSync(repo)
  git(dir, 'init', '--bare', remote)
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.email', 'fixture@example.invalid'); git(repo, 'config', 'user.name', 'Fixture')
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node test.mjs' } }))
  fs.writeFileSync(path.join(repo, 'answer.mjs'), 'export const answer = () => 1;\n')
  fs.writeFileSync(path.join(repo, 'test.mjs'), "import assert from 'node:assert/strict'; import {answer} from './answer.mjs'; assert.equal(answer(), 2);\n")
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'initial'); git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '-u', 'origin', 'main')
  const config = ConfigSchema.parse({ auth: { mode: 'indie' }, repos: { path: repo, default_base_branch: 'main' }, slack: { workspace_team_id: 'T1', allowed_users: ['U1'] }, policy: { room: 'never', track_small_fixes: 'none' } })
  const store = new Store(':memory:')
  const c = { adapter: 'slack', eventId: 'initial', key, author: 'U1', text: 'fix', channel: 'C1', thread: '1', team: 'T1' }
  const run = store.accept(c, repo, 24); store.finish(run.runId, 'completed')
  const prs = new Map(), calls = [], pages = new Map(), sections = new Map(), notices = [], gates = []
  let prNumber = 0, pageNumber = 0, lostCreate = false
  const cmd = async (name, args, cwd, signal) => {
    if (name !== 'gh') return command(name, args, cwd, signal)
    calls.push(args)
    const flag = name => args[args.indexOf(name) + 1]
    if (args[1] === 'list') return JSON.stringify([...prs.values()].filter(pr => pr.branch === flag('--head')))
    if (args[1] === 'create') {
      const url = `https://github.com/fixture/repo/pull/${++prNumber}`
      prs.set(url, { url, state: 'OPEN', branch: flag('--head'), headRefName: flag('--head'), baseRefName: flag('--base'), headRefOid: git(cwd, 'rev-parse', 'HEAD') })
      if (lostCreate) { lostCreate = false; throw new Error('lost response') }
      return url
    }
    if (args[1] === 'edit') { prs.get(args[2]).headRefOid = git(cwd, 'rev-parse', 'HEAD'); return '' }
    if (args[1] === 'view') return JSON.stringify(prs.get(args[2]))
    throw new Error(`Unexpected gh ${args.join(' ')}`)
  }
  const changes = new Changes(store, config, repo, path.join(dir, 'worktrees'), cmd)
  const tracker = {
    async create(id, title) { const page = { id: `page-${++pageNumber}`, url: `https://notion.so/page-${pageNumber}`, title }; pages.set(id, page); return page },
    async find(id) { return pages.get(id) },
    async section(id, section, md) { sections.set(`${id}:${section}`, md) },
    async done(id) { notices.push(`done:${id}`) },
  }
  const output = { async notice(c, text) { notices.push(text) }, async status() {}, async delta() {}, async finish() {}, async gate(c, gate, text) { gates.push({ c, gate, text }) } }
  const tasks = new Tasks(store, config, changes, tracker, output)
  const open = async () => {
    const w = await changes.open(key, '.')
    store.db.prepare('UPDATE worktrees SET origin=? WHERE id=?').run('https://github.com/fixture/repo.git', w.id)
    return changes.get(key, '.')
  }
  return { dir, repo, remote, config, store, changes, tasks, tracker, output, pages, sections, notices, gates, prs, calls, open,
    c: store.conversation(key), lostCreate() { lostCreate = true }, close() { store.close() } }
}

try {
  await check('small_fix counts additions and deletions, rejects binaries and protected paths', () => {
    const config = ConfigSchema.parse({ auth: { mode: 'indie' }, repos: { path: root }, slack: { workspace_team_id: 'T1', allowed_users: ['U1'] } }).policy.small_fix
    const parse = raw => parseNumstat(raw)
    assert.equal(smallFix(parse('1\t1\tapp.ts\0'), config), null)
    assert.match(smallFix(parse('100\t51\tapp.ts\0'), config), /151/)
    assert.match(smallFix(parse('-\t-\timage.png\0'), config), /binarios/)
    for (const file of ['db/migrations/001.sql', 'schema.prisma', 'infra/main.tf', '.github/workflows/test.yml']) assert.ok(smallFix(parse(`1\t0\t${file}\0`), config), file)
    assert.equal(parse('1\t0\tfile\nwith\tspace.ts\0')[0].path, 'file\nwith\tspace.ts')
    assert.throws(() => parse('bad'), /invalido/)
  })
  await check('worktrees: fresh remote base, stable identity, separate conversations, no shared edits', async () => {
    const f = fixture()
    try {
      const w = await f.open(), again = await f.changes.open(key, '.')
      assert.equal(w.id, again.id)
      assert.equal(w.base_sha, git(f.repo, 'rev-parse', 'origin/main'))
      const accepted = f.store.accept({ adapter: 'slack', eventId: 'other', key: 'slack:C2:1', author: 'U1', text: 'fix', channel: 'C2' }, f.repo, 24)
      f.store.finish(accepted.runId, 'completed')
      assert.notEqual((await f.changes.open('slack:C2:1', '.')).dir, w.dir)
      fs.writeFileSync(path.join(w.dir, 'answer.mjs'), 'export const answer = () => 2;\n')
      assert.match(fs.readFileSync(path.join(f.repo, 'answer.mjs'), 'utf8'), /=> 1/)
      assert.throws(() => f.changes.repo('..'), /dentro/)
    } finally { f.close() }
  })
  await check('SQLite upgrade preserves phase-1 conversations, sessions and queued messages', () => {
    const file = path.join(root, 'upgrade.sqlite')
    let store = new Store(file)
    const accepted = store.accept({ adapter: 'slack', eventId: 'old', key, author: 'U1', text: 'queued before upgrade', channel: 'C1' }, root, 24)
    store.session(key, 'old-session')
    store.db.exec(`DROP TABLE task_gates; DROP TABLE sections; DROP TABLE tasks; DROP TABLE prs; DROP TABLE worktrees; DROP TABLE effects;
      ALTER TABLE runs DROP COLUMN reply_channel; ALTER TABLE runs DROP COLUMN intent; PRAGMA user_version=1;`)
    store.close(); store = new Store(file)
    assert.equal(store.conversation(key).session_id, 'old-session')
    assert.equal(store.run(accepted.runId).state, 'queued')
    assert.equal(store.run(accepted.runId).intent, 'ask')
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2)
    store.close()
  })
  await check('publish: tests tied to final tree, commit/push and idempotent PR', async () => {
    const f = fixture()
    try {
      const w = await f.open()
      fs.writeFileSync(path.join(w.dir, 'answer.mjs'), 'export const answer = () => 2;\n')
      const args = { repo: '.', title: 'Fix answer', body_md: 'Fix with literal `code` and\nnewlines.' }
      assert.equal((await f.tasks.openPr(f.c, args)).refused, true)
      assert.equal(f.calls.length, 0)
      assert.equal((await f.changes.tests(key, '.')).passed, true)
      const result = await f.tasks.openPr(f.c, args)
      assert.match(result.url, /pull\/1$/)
      await f.tasks.openPr(f.c, args)
      assert.equal(f.prs.size, 1)
      assert.equal(f.calls.filter(c => c[1] === 'edit').length, 1)
      fs.appendFileSync(path.join(w.dir, 'answer.mjs'), '// changed after tests\n')
      assert.equal((await f.tasks.openPr(f.c, args)).refused, true)
      assert.equal(git(f.repo, 'status', '--porcelain'), '')
    } finally { f.close() }
  })
  await check('publish: lost GitHub response reconciles by branch without a second PR', async () => {
    const f = fixture()
    try {
      const w = await f.open()
      fs.writeFileSync(path.join(w.dir, 'answer.mjs'), 'export const answer = () => 2;\n')
      await f.changes.tests(key, '.')
      f.lostCreate()
      const args = { repo: '.', title: 'Fix', body_md: 'Fixed' }
      await assert.rejects(() => f.tasks.openPr(f.c, args), /lost response/)
      assert.match((await f.tasks.openPr(f.c, args)).url, /pull\/1$/)
      assert.equal(f.prs.size, 1)
    } finally { f.close() }
  })
  await check('tests: a failing command never authorizes a PR and rewritten test scripts are refused', async () => {
    const f = fixture()
    try {
      const w = await f.open()
      await assert.rejects(() => f.changes.tests(key, '.'))
      assert.equal(f.changes.get(key, '.').test_passed, 0)
      fs.writeFileSync(path.join(w.dir, 'package.json'), JSON.stringify({ scripts: { test: 'true' } }))
      await assert.rejects(() => f.changes.tests(key, '.'), /scripts de test cambiaron/)
    } finally { f.close() }
  })
  await check('tasks: create/upsert dedupe and plan approval blocks cross-task or stale writes', async () => {
    const f = fixture()
    try {
      const args = { title: 'Task', summary_md: 'Business summary', size: 'M', impact: 'medium' }
      const task = await f.tasks.create(f.c, args)
      assert.equal((await f.tasks.create(f.c, args)).id, task.id); assert.equal(f.pages.size, 1)
      assert.equal(f.tasks.canWrite(key), false)
      const plan = await f.tasks.update(f.c, { task_id: task.id, section: 'plan', md: 'Implement the change and test it.', questions: [] })
      f.tasks.decide(plan.gate_id, 'approve', 'U1', 'C1')
      assert.equal(f.tasks.canWrite(key), true)
      await f.tasks.create(f.c, { ...args, plan_md: 'Unreviewed replacement' })
      assert.equal(f.sections.get(`${task.notion_id}:plan`), 'Implement the change and test it.')
      const changed = await f.tasks.update(f.c, { task_id: task.id, section: 'plan', md: 'Alternative plan.', questions: [] })
      assert.equal(f.tasks.canWrite(key), false)
      f.tasks.decide(plan.gate_id, 'approve', 'U1', 'C1')
      assert.equal(f.tasks.canWrite(key), false)
      await assert.rejects(() => f.tasks.update({ ...f.c, key: 'other' }, { task_id: task.id, section: 'summary', md: 'bad' }), /otra conversacion/)
      assert.notEqual(plan.gate_id, changed.gate_id)
    } finally { f.close() }
  })
  await check('plans with questions have no approve button and no fast track', async () => {
    const f = fixture()
    try {
      f.config.policy.fast_track = true
      const task = await f.tasks.create(f.c, { title: 'Question', summary_md: 'Summary', size: 'S', impact: 'low' })
      const result = await f.tasks.update(f.c, { task_id: task.id, section: 'plan', md: 'Which repo?', questions: [] })
      assert.throws(() => f.tasks.decide(result.gate_id, 'approve', 'U1'), /preguntas/)
      const calls = []
      const output = new SlackOutput(async (method, args) => { calls.push(args); return {} })
      await output.gate(f.c, f.gates.at(-1).gate, 'Review')
      assert.ok(!JSON.stringify(calls).includes('regent_gate_approve'))
      assert.equal(f.tasks.canWrite(key), false)
      const fast = await f.tasks.update(f.c, { task_id: task.id, section: 'plan', md: 'Fix one file; run tests.', questions: [] })
      assert.equal(fast.fast_track, true); assert.equal(f.tasks.canWrite(key), true)
    } finally { f.close() }
  })
  await check('effects: concurrent calls and remote success/local failure do not duplicate', async () => {
    const store = new Store(':memory:'), effects = new Effects(store)
    try {
      let creates = 0
      const create = async () => { creates++; return { id: 'one' } }
      assert.deepEqual(await Promise.all([effects.once('key', create, async () => undefined), effects.once('key', create, async () => undefined)]), [{ id: 'one' }, { id: 'one' }])
      assert.equal(creates, 1)
      await assert.rejects(() => effects.once('lost', async () => { throw new Error('timeout') }, async () => undefined))
      assert.deepEqual(await effects.once('lost', create, async () => ({ id: 'remote' })), { id: 'remote' })
      assert.equal(creates, 1)
      await assert.rejects(() => effects.once('uncertain', async () => { throw new Error('timeout') }, async () => undefined))
      await assert.rejects(() => effects.once('uncertain', create, async () => undefined), /no se repetira/)
      assert.equal(creates, 1)
    } finally { store.close() }
  })
  await check('QA freezes small planned tasks after approval', async () => {
    const f = fixture()
    try {
      const task = await f.tasks.create(f.c, { title: 'Small planned task', summary_md: 'Summary', size: 'S', impact: 'low' })
      f.store.db.prepare("UPDATE tasks SET state='awaiting_merge' WHERE id=?").run(task.id)
      assert.equal(f.tasks.canWrite(key), false)
    } finally { f.close() }
  })
  await check('explicit test command supports the workspace root repo', async () => {
    const f = fixture()
    try {
      f.config.repos.test_commands['.'] = [process.execPath, 'test.mjs']
      const w = await f.open()
      assert.deepEqual(JSON.parse(w.test_command), [process.execPath, 'test.mjs'])
      fs.writeFileSync(path.join(w.dir, 'answer.mjs'), 'export const answer = () => 2;\n')
      assert.equal((await f.changes.tests(key, '.')).passed, true)
    } finally { f.close() }
  })
  await check('GitHub webhook verifies exact bytes, rejects invalid payloads and deduplicates merge wakeups', async () => {
    const store = new Store(':memory:')
    let wakeups = 0
    const server = createHttp({ store }, () => ({}), () => { wakeups++ }, 'test-secret')
    try {
      server.listen(0, '127.0.0.1'); await once(server, 'listening')
      const url = `http://127.0.0.1:${server.address().port}/webhooks/github`
      const raw = JSON.stringify({ action: 'closed', pull_request: { merged: true } })
      const signature = body => `sha256=${createHmac('sha256', 'test-secret').update(body).digest('hex')}`
      const send = (body, delivery, sig = signature(body), event = 'pull_request') => fetch(url, { method: 'POST', body,
        headers: { 'x-hub-signature-256': sig, 'x-github-delivery': delivery, 'x-github-event': event } })
      assert.equal((await send(raw, 'bad', 'invalid')).status, 401)
      assert.equal((await send(`${raw} `, 'changed', signature(raw))).status, 401)
      assert.equal((await send('{', 'malformed')).status, 400)
      assert.equal((await send('null', 'null')).status, 400)
      assert.equal((await send(raw, '')).status, 400)
      const first = await send(raw, 'merge-1')
      assert.equal(first.status, 202); assert.equal((await first.json()).duplicate, false)
      assert.equal((await (await send(raw, 'merge-1')).json()).duplicate, true)
      await send(JSON.stringify({ action: 'closed', pull_request: { merged: false } }), 'closed')
      await send(raw, 'ping', undefined, 'ping')
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(wakeups, 1)
      assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM inbound WHERE adapter='github'").get().n, 3)
    } finally {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
      store.close()
    }
  })
  await check('full task: plan -> PR -> QA revision -> merge -> Done and clean, exactly one completion', async () => {
    const f = fixture()
    try {
      const task = await f.tasks.create(f.c, { title: 'Medium fix', summary_md: 'Fix the business bug', size: 'M', impact: 'medium' })
      const plan = await f.tasks.update(f.c, { task_id: task.id, section: 'plan', md: 'Implement and test.', questions: [] })
      f.tasks.decide(plan.gate_id, 'approve', 'U1')
      const w = await f.open()
      fs.writeFileSync(path.join(w.dir, 'answer.mjs'), 'export const answer = () => 2;\n')
      await f.changes.tests(key, '.')
      const args = { repo: '.', title: 'Medium fix', body_md: 'Implementation' }
      const result = await f.tasks.openPr(f.c, args)
      const qa = await f.tasks.requestQa(f.c)
      fs.appendFileSync(path.join(w.dir, 'answer.mjs'), '// revised\n')
      await f.changes.tests(key, '.'); await f.tasks.openPr(f.c, args)
      assert.throws(() => f.tasks.decide(qa.gate_id, 'approve', 'U1'), /PR cambio/)
      const qa2 = await f.tasks.requestQa(f.c)
      f.tasks.decide(qa2.gate_id, 'approve', 'U1')
      await f.tasks.poll(); assert.equal(f.tasks.get(task.id).state, 'awaiting_merge')
      f.prs.get(result.url).state = 'MERGED'
      await f.tasks.poll(); await f.tasks.poll()
      assert.equal(f.tasks.get(task.id).state, 'completed')
      assert.equal(fs.existsSync(w.dir), false)
      assert.equal(f.notices.filter(n => n === 'Todos los PRs fueron integrados. Tarea completada.').length, 1)
    } finally { f.close() }
  })
  await check('cleanup preserves dirty worktrees', async () => {
    const f = fixture()
    try {
      const w = await f.open()
      fs.writeFileSync(path.join(w.dir, 'unsaved.txt'), 'keep')
      assert.equal(await f.changes.clean(w), false)
      assert.ok(fs.existsSync(path.join(w.dir, 'unsaved.txt')))
    } finally { f.close() }
  })
  await check('small-fix card policy creates one traceability card and closes it on merge', async () => {
    const f = fixture()
    try {
      f.config.policy.track_small_fixes = 'card'
      const w = await f.open()
      fs.writeFileSync(path.join(w.dir, 'answer.mjs'), 'export const answer = () => 2;\n')
      await f.changes.tests(key, '.')
      const args = { repo: '.', title: 'Small', body_md: 'Traceable fix' }
      const result = await f.tasks.openPr(f.c, args)
      await f.tasks.openPr(f.c, args)
      assert.equal(f.pages.size, 1)
      assert.equal(f.tasks.of(key).size, 'S')
      f.prs.get(result.url).state = 'MERGED'
      await f.tasks.poll()
      assert.equal(f.tasks.of(key).state, 'completed')
    } finally { f.close() }
  })
  await check('all PRs must merge before a multi-repo task closes', async () => {
    const f = fixture()
    try {
      const task = await f.tasks.create(f.c, { title: 'Two repos', summary_md: 'Summary', size: 'M', impact: 'medium' })
      f.store.db.prepare("UPDATE tasks SET state='awaiting_merge' WHERE id=?").run(task.id)
      const w = await f.open()
      f.store.db.prepare('INSERT INTO worktrees(id,conversation_key,repo,dir,branch,base,base_sha,origin) VALUES(?,?,?,?,?,?,?,?)').run('other', key, `${f.repo}/other`, `${w.dir}-other`, 'agent/other', 'main', w.base_sha, w.origin)
      f.store.db.prepare('INSERT INTO prs(worktree_id,url,head) VALUES(?,?,?)').run(w.id, 'https://github.com/fixture/repo/pull/1', 'one')
      f.store.db.prepare('INSERT INTO prs(worktree_id,url,head) VALUES(?,?,?)').run('other', 'https://github.com/fixture/other/pull/2', 'two')
      let secondMerged = false
      f.changes.merged = async w => w.id !== 'other' || secondMerged
      f.changes.clean = async w => { f.store.db.prepare("UPDATE worktrees SET state='cleaned' WHERE id=?").run(w.id); return true }
      await f.tasks.poll()
      assert.equal(f.tasks.get(task.id).state, 'awaiting_merge')
      secondMerged = true; await f.tasks.poll()
      assert.equal(f.tasks.get(task.id).state, 'completed')
    } finally { f.close() }
  })
  await check('core hooks: only own worktrees, no symlink escape, base writes or permission changes', async () => {
    const f = fixture()
    let finish
    const core = new Core({ store: f.store, config: f.config, output: f.output, cwd: f.repo,
      runner: () => ({ done: new Promise(resolve => { finish = resolve }), cancel: () => finish({ state: 'interrupted', text: '', error: 'cancelled', cost: 0, usage: {} }) }) })
    core.changes = f.changes; core.tasks = f.tasks
    try {
      await core.submit({ adapter: 'slack', eventId: 'active', key, author: 'U1', text: 'fix', channel: 'C1', thread: '1', team: 'T1' })
      const token = [...core.active.values()][0].token
      const w = await f.open()
      const edit = file => core.permission(token, { tool_name: 'Edit', tool_input: { file_path: file } })
      assert.equal(edit(path.join(w.dir, 'answer.mjs')), null)
      assert.match(edit(path.join(f.repo, 'answer.mjs')), /compartidos/)
      assert.match(edit(path.join(w.dir, '.claude/settings.json')), /permisos/)
      fs.symlinkSync(f.repo, path.join(w.dir, 'escape'))
      assert.ok(edit(path.join(w.dir, 'escape/answer.mjs')))
      const task = await f.tasks.create(f.c, { title: 'Requires plan', summary_md: 'Summary', size: 'M', impact: 'high' })
      assert.match(edit(path.join(w.dir, 'answer.mjs')), /aprobar/)
      await assert.rejects(() => core.reviewGate('missing', 'approve', 'U2', 'T1'), /no autorizado/)
      assert.ok(task.id)
    } finally { await core.close(); f.close() }
  })
  await check('a reply during plan delivery stays queued for the resumed turn', async () => {
    const f = fixture()
    let finish
    const core = new Core({ store: f.store, config: f.config, output: f.output, cwd: f.repo,
      runner: () => ({ done: new Promise(resolve => { finish = resolve }), cancel: () => finish({ state: 'interrupted', text: '', error: 'cancelled', cost: 0, usage: {} }) }) })
    core.changes = f.changes; core.tasks = f.tasks
    try {
      await core.submit({ adapter: 'slack', eventId: 'active', key, author: 'U1', text: 'plan', channel: 'C1', thread: '1', team: 'T1' })
      const active = [...core.active.values()][0]
      const task = await f.tasks.create(f.c, { title: 'Plan reply', summary_md: 'Summary', size: 'M', impact: 'medium' })
      f.output.gate = async () => {
        assert.equal(active.waiting, true)
        await core.submit({ adapter: 'slack', eventId: 'early-reply', key, author: 'U1', text: 'Adjust the plan', channel: 'C1', thread: '1', team: 'T1' })
      }
      await core.tool(active.token, 'regent_update_task', { task_id: task.id, section: 'plan', md: 'Plan for review.' })
      assert.equal(active.resumeAfterWait, true)
      assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE state='queued'").get().n, 1)
    } finally { await core.close(); f.close() }
  })
  await check('CLI recovery does not consume Slack gate decisions', async () => {
    const f = fixture()
    const core = new Core({ store: f.store, config: f.config, output: f.output, cwd: f.repo, adapter: 'cli' })
    core.changes = f.changes; core.tasks = f.tasks
    try {
      const task = await f.tasks.create(f.c, { title: 'Slack only', summary_md: 'Summary', size: 'M', impact: 'medium' })
      const plan = await f.tasks.update(f.c, { task_id: task.id, section: 'plan', md: 'Review this plan.' })
      f.tasks.decide(plan.gate_id, 'approve', 'U1', 'C1')
      await core.recover()
      assert.equal(f.store.db.prepare('SELECT dispatched FROM task_gates WHERE id=?').get(plan.gate_id).dispatched, 0)
      assert.equal(core.active.size, 0)
    } finally { await core.close(); f.close() }
  })
  await check('Notion section upsert preserves unrelated content and reuses plan page', async () => {
    let counter = 0
    const blocks = new Map([['page', [{ id: 'human', type: 'paragraph', paragraph: { rich_text: [{ text: { content: 'Human notes' } }] } }]]])
    const notion = {
      blocks: {
        children: {
          async list({ block_id }) { return { results: blocks.get(block_id) ?? [], has_more: false } },
          async append({ block_id, children }) {
            const added = children.map(c => ({ ...c, id: `block-${++counter}` }))
            blocks.set(block_id, [...(blocks.get(block_id) ?? []), ...added]); return { results: added }
          },
        },
        async delete({ block_id }) { for (const [id, list] of blocks) blocks.set(id, list.filter(b => b.id !== block_id)) },
      },
      pages: { async create({ parent }) {
        const page = { id: `page-${++counter}`, type: 'child_page', child_page: { title: 'Plan tecnico' } }
        blocks.set(parent.page_id, [...blocks.get(parent.page_id), page]); return page
      } },
    }
    const anchor = await upsertSection(notion, 'page', 'Implementacion', 'First')
    assert.equal(await upsertSection(notion, 'page', 'Implementacion', 'Second'), anchor)
    assert.equal(blocks.get('page').filter(b => b.type === 'heading_2').length, 1)
    assert.equal(blocks.get(anchor).length, 1)
    assert.ok(blocks.get('page').some(b => b.id === 'human'))
    assert.equal(await upsertPlan(notion, 'page', 'Plan 1'), await upsertPlan(notion, 'page', 'Plan 2'))
  })
  await check('board properties: typed url/select/people, and missing or unmapped columns skip loudly', async () => {
    const updates = []
    const client = {
      dataSources: { async retrieve() { return { properties: {
        Name: { type: 'title' }, Status: { type: 'status', status: { options: [{ name: 'Backlog' }] } },
        Repo: { type: 'url' }, PR: { type: 'url' },
        Estimacion: { type: 'select', select: { options: [{ name: 'Small' }, { name: 'Large' }] } },
        Owner: { type: 'people' },
      } } } },
      pages: { async update(args) { updates.push(args) } },
    }
    const config = ConfigSchema.parse({ auth: { mode: 'indie' }, repos: { path: root }, slack: { workspace_team_id: 'T1', allowed_users: ['U1'] },
      notion: { properties: { status: 'Status', repo: 'Repo', pr: 'PR', estimation: 'Estimacion', owner: 'Owner' }, people: { U1: 'notion-user-1' }, estimation_values: { S: 'Small', M: 'Medium' } } })
    const tracker = new NotionTracker(config, client, 'source')
    const ok = await tracker.properties('page', { repo: 'https://github.com/o/r', pr: 'https://github.com/o/r/pull/2', size: 'S', owner: 'U1' })
    assert.deepEqual(ok.skipped, [])
    assert.deepEqual(updates[0].properties, { Repo: { url: 'https://github.com/o/r' }, PR: { url: 'https://github.com/o/r/pull/2' },
      Estimacion: { select: { name: 'Small' } }, Owner: { people: [{ object: 'user', id: 'notion-user-1' }] } })
    // size M -> 'Medium' is not a board option; U2 has no Notion mapping: both are reported, neither is written.
    const partial = await tracker.properties('page', { size: 'M', owner: 'U2' })
    assert.ok(partial.skipped.some(s => /estimation/.test(s)) && partial.skipped.some(s => /owner/.test(s)))
    assert.equal(updates.length, 1)
  })
  await check('room: always gives an untasked patch a traceability card and a room', async () => {
    const f = fixture()
    try {
      f.config.policy.room = 'always'
      const created = []
      f.tasks.rooms = {
        async create(name, author, text) { created.push({ name, author, text }); return { channel: 'ROOM1', thread: 'r1' } },
        async find() { return undefined },
        async history() { return 'conversation digest' },
        async archive() {},
      }
      const w = await f.open()
      fs.writeFileSync(path.join(w.dir, 'answer.mjs'), 'export const answer = () => 2;\n')
      await f.changes.tests(key, '.')
      const result = await f.tasks.openPr(f.c, { repo: '.', title: 'Roomed fix', body_md: 'Fix' })
      assert.match(result.url, /pull\/1$/)
      assert.equal(created.length, 1)
      assert.equal(f.tasks.of(key).room, 'ROOM1')
      assert.ok(f.notices.includes(`PR: ${result.url}`))
      f.prs.get(result.url).state = 'MERGED'
      await f.tasks.poll()
      assert.equal(f.tasks.of(key).state, 'completed')
    } finally { f.close() }
  })
} finally { fs.rmSync(root, { recursive: true, force: true }) }
if (failed) process.exitCode = 1
