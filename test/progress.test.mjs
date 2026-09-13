import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import { Core } from '../src/core.ts'
import { ConfigSchema } from '../src/config.ts'
import { SlackOutput } from '../src/slack.ts'
import { DurableOutput } from '../src/delivery.ts'
import { interruptedText } from '../src/progress.ts'
import { createHttp } from '../src/http.ts'
import { SlackActivities } from '../src/slack-activities.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'regent-progress-'))
let store, core, durable, server
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
  server = createHttp(core, () => ({}))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const tool = async args => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/tools`, {
      method: 'POST',
      headers: { authorization: `Bearer ${active.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'regent_status', arguments: args } }),
    })
    return response.json()
  }
  for (const args of [{ text: 'Progreso text' }, { status: 'Progreso alias' }, { text: 'Preferido', status: 'Alternativo' }]) {
    active.lastStatusAt = 0
    const result = await tool(args)
    assert.equal(result.error, undefined)
    assert.equal(result.result.isError, undefined)
    assert.equal(calls.at(-1).args.text, args.text ?? args.status)
  }
  const count = calls.length
  assert.match(JSON.stringify(await tool({ status: 'Demasiado pronto' })), /throttled/)
  for (const args of [{}, { status: '' }, { text: '   ' }, { text: 42 }, { status: 'x'.repeat(2001) }]) {
    const result = await tool(args)
    assert.ok(result.error || result.result.isError, 'Invalid status must return an actionable MCP error')
  }
  assert.equal(calls.length, count)
  await assert.rejects(() => core.tool(active.token, 'regent_status', {}), /Mensaje de progreso/)
  await new Promise(resolve => server.close(resolve))
  server = undefined
  calls.length = 0
  // Native animation is not enough when the model posts no narrative updates.
  core.refreshProgress(active, true)
  await active.output
  assert.equal(calls.length, 0, 'A recent status suppresses the heartbeat in animated threads')
  active.lastStatusAt = Date.now() - 46000
  core.refreshProgress(active, true)
  await active.output
  assert.ok(slack.progressMessage(active.run.id))
  const posts = calls.filter(c => c.method === 'chat.postMessage').length
  core.refreshProgress(active, true)
  await active.output
  assert.equal(calls.filter(c => c.method === 'chat.postMessage').length, posts, 'Heartbeat updates one message')

  const activities = new SlackActivities(async () => { throw new Error('simulated transport failure') }, store)
  slack.activities = activities
  activities.event(active.conversation, active.run, { kind: 'tool_use', id: 'bash1', name: 'Bash', input: {} })
  await activities.flush()
  await slack.recoverProgress()
  assert.ok(slack.progressMessage(active.run.id), 'An undelivered activity must not erase the fallback')
  core.refreshProgress(active, true)
  await active.output
  assert.ok(slack.progressMessage(active.run.id))
  const record = activities.get(active.run.id)
  record.ts = 'delivered-activity'
  record.delivered = record.desired
  record.sent = record.revision
  activities.save(active.run.id, record)
  await slack.recoverProgress()
  assert.equal(slack.progressMessage(active.run.id), undefined, 'Delivered activity replaces the fallback')
  slack.activities = undefined
  store.db.prepare('DELETE FROM activity_progress').run()
  calls.length = 0
  console.log('  OK MCP text/status alias, validation, throttling, native heartbeat and undelivered activity fallback')
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
  if (server) await new Promise(resolve => server.close(resolve))
  if (core && !core.stopping) await core.close()
  if (durable) await durable.close()
  if (store) store.close()
  fs.rmSync(root, { recursive: true, force: true })
}
