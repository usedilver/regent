import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { ConfigSchema } from '../../src/config.ts'
import { Core } from '../../src/core/core.ts'
import { Store } from '../../src/storage/store.ts'
import { createHttp } from '../../src/adapters/http.ts'

if (process.env.REGENT_SMOKE !== '1') {
  console.error(
    'Opt-in: REGENT_SMOKE=1 node test/smoke/project-threads.mjs. Uses the official CLI/operator auth and incurs normal provider usage.',
  )
  process.exit(1)
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-threads-smoke-')))
const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)),
  )
const close = (server) => new Promise((resolve) => server.close(resolve))
const git = (cwd, ...args) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim()

function project(dir, readme) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'README.md'), readme)
  fs.writeFileSync(path.join(dir, '.gitignore'), '.claude/worktrees/\n.worktrees/\n')
  git(dir, 'init', '-b', 'main')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'Fixture')
}

let core
let internal
let store

try {
  const repo = path.join(root, 'repo')
  project(path.join(root, 'api'), 'api service\n')
  project(path.join(root, 'other'), 'other project\n')
  project(repo, 'main project\n')
  fs.writeFileSync(
    path.join(repo, 'CLAUDE.md'),
    'Fixture. No subagents, no commits, no tests, no extra files. Follow the core execution mode.\n',
  )
  git(
    repo,
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    path.join(root, 'api'),
    'services/api',
  )
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'Add the api service')

  store = new Store(path.join(root, 'state.sqlite'))
  const config = ConfigSchema.parse({
    auth: { mode: 'indie' },
    repos: { path: root, default_repo: 'repo' },
    slack: { workspace_team_id: 'T1', allowed_users: ['U1'] },
    models: { ask: 'sonnet', patch: 'sonnet', task: 'sonnet', project: 'sonnet' },
    limits: {
      max_run_sec: { ask: 180, patch: 180, task: 180, project: 180 },
      stall_sec: 90,
      cancel_grace_sec: 2,
    },
  })
  core = new Core({
    store,
    config,
    cwd: root,
    output: { async notice() {}, async status() {}, async delta() {}, async finish() {} },
    runnerOverrides: { command: 'claude' },
  })
  const proposals = []
  core.threads = {
    async propose(c, proposal) {
      proposals.push({ key: c.key, ...proposal })
      return `proposal-${proposals.length}`
    },
    async open() {
      throw new Error('The smoke never confirms a thread')
    },
    async permalink() {
      return undefined
    },
    async settle() {},
    async whisper() {},
  }
  internal = createHttp(core, () => ({}))
  core.toolsUrl = (await listen(internal)) + '/tools'

  const run = async (key, text) => {
    const accepted = await core.submit({
      adapter: 'slack',
      key,
      author: 'U1',
      team: 'T1',
      channel: 'C1',
      eventId: randomUUID(),
      text,
    })

    while (core.active.size) {
      await Promise.all([...core.active.values()].map((active) => active.done))
    }

    return store.run(accepted.runId)
  }

  const otherChange = await run(
    'other-change',
    'Necesito que el README.md del proyecto other diga exactamente "hola other". Hazlo.',
  )
  assert.equal(proposals.filter((p) => p.key === 'other-change').length, 1, otherChange.result)
  assert.equal(proposals[0].project, 'other')
  assert.equal(otherChange.state, 'waiting_human', otherChange.result)
  assert.equal(fs.readFileSync(path.join(root, 'other', 'README.md'), 'utf8'), 'other project\n')
  console.log('PASS change in an independent project: one proposal, nothing edited, waits')

  const serviceChange = await run(
    'service-change',
    'Cambia el README.md del servicio services/api para que diga exactamente "hola api". No hagas commits.',
  )
  assert.equal(proposals.filter((p) => p.key === 'service-change').length, 0, serviceChange.result)
  assert.equal(serviceChange.state, 'completed', serviceChange.error || serviceChange.result)
  console.log('PASS change in a submodule of the same project: no thread proposed')

  const otherRead = await run(
    'other-read',
    '/ask ¿Qué dice el README.md del proyecto other? Solo léelo, no cambies nada.',
  )
  assert.equal(proposals.filter((p) => p.key === 'other-read').length, 0, otherRead.result)
  assert.match(otherRead.result, /other project/)
  console.log('PASS reading an independent project: no thread proposed')
} finally {
  await core?.close()
  if (internal) await close(internal)
  store?.close()
  fs.rmSync(root, { recursive: true, force: true })
}
