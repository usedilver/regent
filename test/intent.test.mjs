import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { requestProfile } from '../src/core/intent.ts'
import { Core } from '../src/core/core.ts'
import { Store } from '../src/storage/store.ts'
import { ConfigSchema } from '../src/config.ts'

test('ordinary messages reach the executor unchanged through one profile', () => {
  for (const text of [
    'Quita este div y crea el PR',
    '¿Qué hace este componente?',
    'Investiga sin hacer cambios',
    'Dame un preview',
    'continua',
    'sí',
    'Create a new app',
    'Explique ce composant',
    'Implementa lo anterior',
  ]) {
    assert.deepEqual(requestProfile(text), { intent: 'task', text })
  }
})

test('only explicit protocol prefixes select a different profile', () => {
  assert.deepEqual(requestProfile('/ask Explica el código'), {
    intent: 'ask',
    text: 'Explica el código',
  })
  assert.deepEqual(requestProfile(' /PATCH cambia el footer'), {
    intent: 'patch',
    text: 'cambia el footer',
  })
  assert.deepEqual(requestProfile('/project crea la app'), {
    intent: 'project',
    text: 'crea la app',
  })
  assert.deepEqual(requestProfile('/task ejecuta el build'), {
    intent: 'task',
    text: 'ejecuta el build',
  })
  assert.deepEqual(requestProfile('/asker is a path'), { intent: 'task', text: '/asker is a path' })
})

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-intent-')))
const repo = path.join(root, 'new-app')
fs.mkdirSync(repo)
fs.mkdirSync(path.join(repo, '.git'))
const store = new Store(':memory:')
const starts = []
const config = ConfigSchema.parse({
  auth: { mode: 'indie' },
  repos: { path: root, default_repo: 'new-app' },
  slack: { workspace_team_id: 'T1', allowed_users: ['U1'] },
  models: { ask: 'sonnet-test', patch: 'opus-patch', task: 'opus-task', project: 'opus-project' },
})
const core = new Core({
  config,
  store,
  cwd: root,
  output: Object.fromEntries(
    ['notice', 'status', 'delta', 'finish'].map((k) => [k, async () => {}]),
  ),
  runner: (opts) => {
    let finish
    const done = new Promise((resolve) => {
      finish = () => resolve({ state: 'completed', text: 'ok', error: '', cost: 0, usage: {} })
    })

    starts.push({ opts, finish })
    return { done, cancel: finish }
  },
})
const inbound = (id, text) => ({
  adapter: 'slack',
  eventId: id,
  key: 'slack:C1:1',
  author: 'U1',
  channel: 'C1',
  thread: '1',
  team: 'T1',
  text,
})

const until = async (predicate) => {
  for (let i = 0; i < 1000; i++) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 2))
  }

  throw new Error('Timed out')
}

try {
  await core.submit({ ...inbound('create', 'crea un proyecto de gastos'), intent: 'task' })
  await until(() => starts.length === 1)
  assert.equal(starts[0].opts.model, 'opus-task')
  assert.ok(starts[0].opts.timeoutMs <= 3600000 && starts[0].opts.timeoutMs > 3600000 * 0.99)
  const active = core.active.get('slack:C1:1')
  await core.tool(active.token, 'regent_use_repo', {
    repo,
    intent: 'project',
    handoff: 'construir toda la app',
  })
  await until(() => starts.length === 2)
  assert.equal(starts[1].opts.model, 'opus-project')
  assert.ok(starts[1].opts.timeoutMs <= 7200000 && starts[1].opts.timeoutMs > 7200000 * 0.99)
  starts[1].finish()
  await until(() => !core.active.size)
  await core.submit(inbound('continue', 'continua'))
  await until(() => starts.length === 3)
  assert.equal(starts[2].opts.model, 'opus-task')
  starts[2].finish()
  await until(() => !core.active.size)
  await core.submit({ ...inbound('question', 'explica el codigo'), intent: 'ask' })
  await until(() => starts.length === 4)
  assert.equal(starts[3].opts.model, 'sonnet-test')
  assert.ok(starts[3].opts.timeoutMs <= 600000 && starts[3].opts.timeoutMs > 600000 * 0.99)
  await assert.rejects(
    () =>
      core.tool(core.active.get('slack:C1:1').token, 'regent_use_repo', {
        repo,
        intent: 'project',
        handoff: 'Do not promote a query without a user editing request',
      }),
    /Query mode/,
  )
  starts[3].finish()
  await until(() => !core.active.size)
  await core.submit(inbound('approved', 'implementalo'))
  await until(() => starts.length === 5)
  assert.equal(starts[4].opts.readOnly, false)
  starts[4].finish()
  await until(() => !core.active.size)
  console.log(
    'Execution options: explicit limits, ordinary follow-ups and enforced query permissions passed',
  )
} finally {
  await core.close()
  store.close()
  fs.rmSync(root, { recursive: true, force: true })
}
