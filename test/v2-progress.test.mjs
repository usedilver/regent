import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/v2/store.ts'
import { Core } from '../src/v2/core.ts'
import { ConfigSchema } from '../src/v2/config.ts'
import { SlackOutput } from '../src/v2/slack.ts'
import { DurableOutput } from '../src/v2/delivery.ts'
import { interruptedText } from '../src/v2/progress.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'regent-progress-'))
let store, core, durable
const until = async fn => { for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)) } throw new Error('Timed out') }
const calls = []
let failStatus = false, failDelete = false, deleted = false
const api = async (method, args) => {
  calls.push({ method, args })
  if (method === 'agents.sessions.setStatus' && failStatus) throw new Error('simulated status failure')
  if (method === 'chat.delete' && failDelete) throw new Error('simulated deletion failure')
  if (method === 'chat.update' && deleted) throw new Error('message_not_found')
  return { ts: String(calls.length) }
}
const input = { adapter: 'slack', eventId: 'event1', key: 'slack:C1:1', channel: 'C1', thread: '1', author: 'U1', team: 'T1', text: 'Review' }
try {
  const file = path.join(root, 'progress.sqlite')
  store = new Store(file)
  const accepted = store.accept(input, root, 24)
  store.start(accepted.runId)
  let slack = new SlackOutput(api)
  slack.store = store
  const c = store.conversation(input.key), run = store.run(accepted.runId)
  assert.equal(slack.animates(c), false)
  await slack.status(c, 'processing')
  assert.equal(slack.animates(c), true)
  failStatus = true
  await slack.status(c, 'processing')
  assert.equal(slack.animates(c), false)
  await slack.progress(c, run, 'Working')
  await slack.progress(c, run, 'Still working')
  assert.equal(calls.filter(c => c.method === 'chat.postMessage').length, 1)
  assert.equal(calls.filter(c => c.method === 'chat.update').length, 1)
  failDelete = true
  await slack.clearProgress(run)
  assert.ok(slack.progressMessage(run.id))
  store.close()
  store = new Store(file)
  slack = new SlackOutput(api)
  slack.store = store
  await slack.recoverProgress()
  assert.ok(slack.progressMessage(run.id), 'A live run must keep its progress')
  store.finish(run.id, 'interrupted', '', 'restart')
  failDelete = false
  await slack.recoverProgress()
  assert.equal(slack.progressMessage(run.id), undefined)
  await slack.progress(c, run, 'Again')
  deleted = true
  await slack.progress(c, run, 'Missing message')
  assert.equal(slack.progressMessage(run.id), undefined)
  deleted = false
  await slack.progress(c, run, 'Recreated')
  assert.ok(slack.progressMessage(run.id))
  await slack.recoverProgress()
  console.log('  OK confirmed native status, fallback updates, failed delete, restart cleanup and removed messages')
  store.close()

  store = new Store(':memory:')
  slack = new SlackOutput(api)
  slack.store = store
  durable = new DurableOutput(store, slack)
  const config = ConfigSchema.parse({ auth: { mode: 'indie' }, repos: { path: root }, slack: { workspace_team_id: 'T1', allowed_users: ['U1'] } })
  let finish, options
  failStatus = false
  calls.length = 0
  core = new Core({ store, config, cwd: root, output: durable, runner: value => {
    options = value
    value.onEvent({ kind: 'init', sessionId: 'session1' })
    const done = new Promise(resolve => { finish = (state = 'completed', text = 'Done') => resolve({ state, text, error: state === 'interrupted' ? 'Se alcanzo el tiempo maximo de ejecucion de este turno.' : '', cost: 0, usage: {} }) })
    return { done, cancel: () => finish('interrupted') }
  } })
  await core.submit(input)
  await until(() => options)
  const active = core.active.get(input.key)
  await active.output
  assert.equal(calls.filter(c => c.method === 'chat.postMessage').length, 0, 'Two status calls must not produce duplicate ACKs')
  failStatus = true
  await slack.status(active.conversation, 'processing')
  core.refreshProgress(active)
  await active.output
  assert.equal(calls.filter(c => c.method === 'chat.postMessage').length, 1)
  failStatus = false
  core.rooms = { async validateUser() {}, async find() {}, async create() { return 'CROOM' }, async invite() {} }
  await core.tool(active.token, 'regent_create_room', { name: 'review', summary: 'Continue here' })
  await active.output
  assert.equal(slack.progressMessage(active.run.id).channel, 'CROOM')
  const before = calls.filter(c => c.method === 'chat.postMessage' && c.args.channel === 'CROOM').length
  core.refreshProgress(active)
  await active.output
  assert.equal(calls.filter(c => c.method === 'chat.postMessage' && c.args.channel === 'CROOM').length, before)
  finish()
  await until(() => !core.active.size)
  assert.equal(slack.progressMessage(active.run.id), undefined)
  await core.close()
  await durable.close()
  store.close()
  console.log('  OK no duplicate ACK, fallback after failure, live thread-to-room move and final cleanup')

  store = new Store(':memory:')
  const messages = []
  options = undefined
  core = new Core({ store, config, cwd: root, runnerOverrides: { timeoutMs: 500 },
    output: { async notice(c, text) { messages.push(text) }, async finish(c, run, text) { messages.push(text) }, async status() {}, async delta() {} },
    runner: value => {
      options = value
      const done = new Promise(resolve => { finish = () => resolve({ state: 'interrupted', text: 'Verified partial findings', error: 'Se alcanzo el tiempo maximo de ejecucion de este turno.', cost: 0, usage: {} }) })
      return { done, cancel: () => finish() }
    } })
  await core.submit(input)
  await until(() => options)
  const closing = core.active.get(input.key)
  assert.match(options.prompt, /wrap_up_at/)
  assert.equal(core.permission(closing.token, { tool_name: 'Read', tool_input: { file_path: 'README.md' } }), null)
  await until(() => messages.some(text => text.includes('limite de tiempo')))
  assert.match(core.permission(closing.token, { tool_name: 'Read' }), /margen de cierre/)
  assert.match(core.permission(closing.token, { tool_name: 'Agent' }), /margen de cierre/)
  assert.equal(core.permission(closing.token, { tool_name: 'mcp__regent__regent_status' }), null)
  assert.equal(core.permission(closing.token, { tool_name: 'TaskOutput' }), null)
  assert.equal(core.permission(closing.token, { tool_name: 'TaskStop' }), null)
  await assert.rejects(() => core.tool(closing.token, 'regent_create_room', {}), /margen de cierre/)
  finish()
  await until(() => !core.active.size)
  const final = messages.find(text => text.includes('Respuesta parcial del agente'))
  assert.ok(final.includes('Verified partial findings'))
  assert.equal(final.match(/escribe continua/g).length, 1)
  assert.match(interruptedText('Timeout.', ''), /No se obtuvo una respuesta parcial/)
  assert.equal(messages.filter(text => text.includes('limite de tiempo')).length, 1)
  console.log('  OK closing margin, one warning, blocked new tools, communication allowed and honest partial result')
} finally {
  if (core && !core.stopping) await core.close()
  if (durable) await durable.close()
  if (store) store.close()
  fs.rmSync(root, { recursive: true, force: true })
}
