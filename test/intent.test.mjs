import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { routeIntent } from '../src/intent.ts'
import { Core } from '../src/core.ts'
import { Store } from '../src/store.ts'
import { ConfigSchema } from '../src/config.ts'

for (const [text, intent] of [
  ['creame un dashboard de prospeccion', 'project'],
  ['Quiero una app para registrar gastos', 'project'],
  ['crea una tarea en notion', 'task'],
  ['corrige los botones del footer', 'patch'],
  ['cual fue la ultima oferta cerrada?', 'ask'],
  ['Como puedo crear un proyecto?', 'ask'],
  ['Investiga este bug, no hagas cambios', 'ask'],
  ['/project retoma los requerimientos adjuntos', 'project'],
]) assert.equal(routeIntent(text).intent, intent, text)
assert.equal(routeIntent('dale', 'project').intent, 'project')
assert.equal(routeIntent('continua', 'patch').intent, 'patch')
assert.equal(routeIntent('explica como funciona', 'project').intent, 'ask')
assert.equal(routeIntent('/patch cambia el footer', 'project').intent, 'patch')
assert.equal(routeIntent('corrige el footer en hire', 'project').intent, 'patch')
assert.equal(routeIntent('quiero cambiar el footer de mi app').intent, 'patch')
assert.equal(routeIntent('crea una tarjeta para el proyecto de ventas').intent, 'task')

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-intent-')))
const repo = path.join(root, 'new-app'); fs.mkdirSync(repo); fs.mkdirSync(path.join(repo, '.git'))
const store = new Store(':memory:'), starts = []
const config = ConfigSchema.parse({ auth: { mode: 'indie' }, repos: { path: root }, slack: { workspace_team_id: 'T1', allowed_users: ['U1'] }, models: { ask: 'sonnet-test', patch: 'opus-patch', task: 'opus-task', project: 'opus-project' } })
const core = new Core({ config, store, cwd: root, output: Object.fromEntries(['notice', 'status', 'delta', 'finish'].map(k => [k, async () => {}])),
  runner: opts => {
    let finish
    const done = new Promise(resolve => { finish = () => resolve({ state: 'completed', text: 'ok', error: '', cost: 0, usage: {} }) })
    starts.push({ opts, finish }); return { done, cancel: finish }
  } })
const inbound = (id, text) => ({ adapter: 'slack', eventId: id, key: 'slack:C1:1', author: 'U1', channel: 'C1', thread: '1', team: 'T1', text })
const until = async predicate => { for (let i = 0; i < 1000; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 2)) } throw new Error('Timed out') }
try {
  await core.submit(inbound('create', 'crea un proyecto de gastos'))
  await until(() => starts.length === 1)
  assert.equal(starts[0].opts.model, 'opus-project'); assert.equal(starts[0].opts.timeoutMs, 7200000)
  const active = core.active.get('slack:C1:1')
  await core.tool(active.token, 'regent_use_repo', { repo, handoff: 'construir toda la app' })
  await until(() => starts.length === 2)
  assert.equal(starts[1].opts.model, 'opus-project'); assert.equal(starts[1].opts.timeoutMs, 7200000)
  starts[1].finish(); await until(() => !core.active.size)
  await core.submit(inbound('continue', 'continua')); await until(() => starts.length === 3)
  assert.equal(starts[2].opts.model, 'opus-project')
  starts[2].finish(); await until(() => !core.active.size)
  await core.submit(inbound('question', 'explica el codigo')); await until(() => starts.length === 4)
  assert.equal(starts[3].opts.model, 'sonnet-test'); assert.equal(starts[3].opts.timeoutMs, 600000)
  await core.tool(core.active.get('slack:C1:1').token, 'regent_use_repo', { repo, intent: 'project', handoff: 'Ahora construir con el perfil explicito' })
  await until(() => starts.length === 5)
  assert.equal(starts[4].opts.model, 'opus-project')
  starts[4].finish(); await until(() => !core.active.size)
  console.log('Routing: project model/time, handoff, continuation, question and explicit escalation passed')
} finally { await core.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }) }
