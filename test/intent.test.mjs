import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { routeIntent } from '../src/core/intent.ts'
import { Core } from '../src/core/core.ts'
import { Store } from '../src/storage/store.ts'
import { ConfigSchema } from '../src/config.ts'

test('requests to run a preview use task while questions and explicit query limits stay read-only', () => {
  for (const text of [
    'dame un preview para revisarlo antes de hacer PR',
    'levanta un preview para revisarlo antes de hacer PR',
    '¿Puedes mostrarme una vista previa de este cambio?',
    'Quiero ver un preview del dashboard',
    'Por favor, prepara una vista previa',
    'Can you show me a preview before opening the PR?',
    'Start a live preview of these changes',
  ]) {
    assert.equal(routeIntent(text, 'patch').intent, 'task', text)
  }

  for (const text of [
    'Explica cómo funciona el preview',
    'Revisa por qué falló el preview',
    '¿Cómo puedo levantar un preview?',
    '¿Puedes revisar el preview?',
    'Dame el enlace del preview existente',
    'No levantes un preview',
    'Dame un preview, solo lectura',
    'Show me a preview, do not edit files',
    '/ask levanta un preview',
  ]) {
    assert.equal(routeIntent(text, 'patch').intent, 'ask', text)
  }

  assert.equal(routeIntent('/patch dame un preview').intent, 'patch')
  assert.equal(routeIntent('Crea una app con preview').intent, 'project')
  assert.equal(routeIntent('Corrige el preview').intent, 'patch')
})

for (const [text, intent] of [
  ['creame un dashboard de prospeccion', 'project'],
  ['Quiero una app para registrar gastos', 'project'],
  ['crea una tarea en notion', 'task'],
  ['corrige los botones del footer', 'patch'],
  ['cual fue la ultima oferta cerrada?', 'ask'],
  ['Como puedo crear un proyecto?', 'ask'],
  ['Investiga este bug, no hagas cambios', 'ask'],
  ['/project retoma los requerimientos adjuntos', 'project'],
]) {
  assert.equal(routeIntent(text).intent, intent, text)
}

assert.equal(routeIntent('dale', 'project').intent, 'project')
assert.equal(routeIntent('continua', 'patch').intent, 'patch')
assert.equal(routeIntent('explica como funciona', 'project').intent, 'ask')
assert.equal(routeIntent('/patch cambia el footer', 'project').intent, 'patch')
assert.equal(routeIntent('corrige el footer en hire', 'project').intent, 'patch')
assert.equal(routeIntent('quiero cambiar el footer de mi app').intent, 'patch')
assert.equal(routeIntent('crea una tarjeta para el proyecto de ventas').intent, 'task')

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
  assert.equal(starts[2].opts.model, 'opus-project')
  starts[2].finish()
  await until(() => !core.active.size)
  await core.submit(inbound('question', 'explica el codigo'))
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
    'Routing: project model/time, handoff, continuation, question and explicit escalation passed',
  )
} finally {
  await core.close()
  store.close()
  fs.rmSync(root, { recursive: true, force: true })
}
