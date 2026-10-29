import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/storage/store.ts'
import { Core } from '../src/core/core.ts'
import { ConfigSchema } from '../src/config.ts'
import { SlackOutput } from '../src/adapters/slack/output.ts'
import { DurableOutput } from '../src/storage/delivery.ts'
import { interruptedText } from '../src/core/progress.ts'
import { createHttp } from '../src/adapters/http.ts'
import { SlackActivities } from '../src/adapters/slack/activities.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'regent-progress-'))
let store
let core
let durable
let server

const until = async (fn) => {
  for (let i = 0; i < 300; i++) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 10))
  }

  throw new Error('Timed out')
}

const calls = []
let failStatus = false
let failDelete = false
let deleted = false

const api = async (method, args) => {
  calls.push({ method, args })

  if (method === 'agents.sessions.setStatus' && failStatus) {
    throw new Error('simulated status failure')
  }

  if (method === 'chat.delete' && failDelete) throw new Error('simulated deletion failure')
  if (method === 'chat.update' && deleted) throw new Error('message_not_found')
  return { ts: String(calls.length) }
}

const input = {
  adapter: 'slack',
  eventId: 'event1',
  key: 'slack:C1:1',
  channel: 'C1',
  thread: '1',
  author: 'U1',
  team: 'T1',
  text: 'Review',
}

try {
  const file = path.join(root, 'progress.sqlite')
  store = new Store(file)
  const accepted = store.accept(input, root, 24)
  store.start(accepted.runId)
  let slack = new SlackOutput(api)
  slack.store = store
  const c = store.conversation(input.key)
  const run = store.run(accepted.runId)

  assert.equal(slack.animates(c), false)
  await slack.status(c, 'processing')
  assert.equal(slack.animates(c), true)
  failStatus = true
  await slack.status(c, 'processing')
  assert.equal(slack.animates(c), false)
  await slack.progress(c, run, 'Working')
  await slack.progress(c, run, 'Still working')
  assert.equal(calls.filter((c) => c.method === 'chat.postMessage').length, 0)
  assert.equal(calls.filter((c) => c.method === 'chat.update').length, 0)
  store.db
    .prepare('INSERT INTO slack_progress VALUES(?,?,?)')
    .run(run.id, c.channel, 'legacy-heartbeat')
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
  assert.equal(slack.progressMessage(run.id), undefined)
  await slack.recoverProgress()
  console.log(
    '  OK confirmed native status, silent progress without cards and legacy heartbeat cleanup',
  )
  store.close()

  store = new Store(':memory:')
  slack = new SlackOutput(api)
  slack.store = store
  slack.activities = new SlackActivities(api, store)
  durable = new DurableOutput(store, slack)
  const config = ConfigSchema.parse({
    auth: { mode: 'indie' },
    repos: { path: root },
    slack: { workspace_team_id: 'T1', allowed_users: ['U1'] },
  })
  let finish
  let options
  failStatus = false
  calls.length = 0
  core = new Core({
    store,
    config,
    cwd: root,
    output: durable,
    runner: (value) => {
      options = value
      value.onEvent({ kind: 'init', sessionId: 'session1' })
      const done = new Promise((resolve) => {
        finish = (state = 'completed', text = 'Done') =>
          resolve({
            state,
            text,
            error:
              state === 'interrupted'
                ? 'Se alcanzo el tiempo maximo de ejecucion de este turno.'
                : '',
            cost: 0,
            usage: {},
          })
      })

      return { done, cancel: () => finish('interrupted') }
    },
  })
  await core.submit(input)
  await until(() => options)
  const active = core.active.get(input.key)
  await active.output
  assert.equal(
    calls.filter((c) => c.method === 'chat.postMessage').length,
    0,
    'Two status calls must not produce duplicate ACKs',
  )
  server = createHttp(core, () => ({}))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

  const tool = async (args) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/tools`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${active.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'regent_status', arguments: args },
      }),
    })

    return response.json()
  }

  for (const args of [
    { text: 'Progreso text' },
    { status: 'Progreso alias' },
    { text: 'Preferido', status: 'Alternativo' },
  ]) {
    active.lastStatusAt = 0
    const result = await tool(args)
    assert.equal(result.error, undefined)
    assert.equal(result.result.isError, undefined)
    assert.equal(slack.activities.get(active.run.id).state.progress, args.text ?? args.status)
  }

  for (const phase of ['investigation', 'implementation', 'validation']) {
    const result = await tool({ phase, text: `Starting ${phase}` })
    assert.equal(result.result.isError, undefined)
    assert.doesNotMatch(JSON.stringify(result), /throttled/)
    assert.equal(slack.activities.get(active.run.id).state.progress, `Starting ${phase}`)
    assert.equal(active.lastPhase, phase)
  }

  assert.match(
    JSON.stringify(await tool({ phase: 'validation', text: 'Repeated validation update' })),
    /throttled/,
  )
  const count = calls.length
  assert.match(JSON.stringify(await tool({ status: 'Demasiado pronto' })), /throttled/)

  for (const args of [
    {},
    { status: '' },
    { text: '   ' },
    { text: 42 },
    { status: 'x'.repeat(2001) },
    { phase: 'completed', text: 'Unknown phase' },
    { phase: 'validation' },
  ]) {
    const result = await tool(args)
    assert.ok(
      result.error || result.result.isError,
      'Invalid status must return an actionable MCP error',
    )
  }

  assert.equal(calls.length, count)
  await assert.rejects(() => core.tool(active.token, 'regent_status', {}), /Progress message/)
  await new Promise((resolve) => server.close(resolve))
  server = undefined
  calls.length = 0
  // Native animation is not enough when the model posts no narrative updates.
  core.refreshProgress(active, true)
  await active.output
  assert.equal(
    calls.filter((c) => c.method === 'chat.postMessage').length,
    0,
    'Heartbeat stays in the activity timeline',
  )
  active.lastStatusAt = Date.now() - 46000
  core.refreshProgress(active, true)
  await active.output
  await slack.activities.flush()
  assert.equal(slack.progressMessage(active.run.id), undefined)
  assert.equal(calls.filter((c) => c.method === 'chat.postMessage').length, 0)
  assert.ok(slack.activities.get(active.run.id).state.progress)
  core.refreshProgress(active, true)
  await active.output
  assert.equal(calls.filter((c) => c.method === 'chat.postMessage').length, 0)

  const failedActivities = new SlackActivities(async () => {
    throw new Error('simulated transport failure')
  }, store)
  slack.activities = failedActivities
  core.refreshProgress(active, true)
  await active.output
  await failedActivities.flush()
  assert.equal(
    slack.progressMessage(active.run.id),
    undefined,
    'Unavailable activity must not create a text fallback',
  )
  calls.length = 0
  failStatus = true
  await slack.status(active.conversation, 'processing')
  core.refreshProgress(active)
  await active.output
  assert.equal(calls.filter((c) => c.method === 'chat.postMessage').length, 0)
  failStatus = false
  slack.activities = new SlackActivities(api, store)
  core.rooms = {
    async validateUser() {},
    async find() {},
    async create() {
      return 'CROOM'
    },
    async invite() {},
  }
  await core.tool(active.token, 'regent_create_room', { name: 'review', summary: 'Continue here' })
  await active.output
  assert.equal(slack.progressMessage(active.run.id), undefined)
  finish()
  await until(() => !core.active.size)
  assert.equal(slack.progressMessage(active.run.id), undefined)
  await core.close()
  await durable.close()
  store.close()
  console.log(
    '  OK no duplicate ACK, fallback after failure, live thread-to-room move and final cleanup',
  )

  store = new Store(':memory:')
  const messages = []
  options = undefined
  core = new Core({
    store,
    config,
    cwd: root,
    runnerOverrides: { timeoutMs: 500 },
    output: {
      async notice(c, text) {
        messages.push(text)
      },
      async finish(c, run, text) {
        messages.push(text)
      },
      async status() {},
      async delta() {},
    },
    runner: (value) => {
      options = value
      const done = new Promise((resolve) => {
        finish = () =>
          resolve({
            state: 'interrupted',
            text: 'Verified partial findings',
            error: 'Se alcanzo el tiempo maximo de ejecucion de este turno.',
            cost: 0,
            usage: {},
          })
      })

      return { done, cancel: () => finish() }
    },
  })
  await core.submit({ ...input, intent: 'ask' })
  await until(() => options)
  const closing = core.active.get(input.key)
  assert.match(options.prompt, /wrap_up_at/)
  assert.equal(
    core.permission(closing.token, { tool_name: 'Read', tool_input: { file_path: 'README.md' } }),
    null,
  )
  await until(
    () =>
      messages.some((text) => text.includes('limite de tiempo')) && Date.now() >= closing.wrapUpAt,
  )
  assert.match(core.permission(closing.token, { tool_name: 'Read' }), /margen de cierre/)
  assert.match(core.permission(closing.token, { tool_name: 'Agent' }), /margen de cierre/)
  assert.equal(core.permission(closing.token, { tool_name: 'mcp__regent__regent_status' }), null)
  assert.match(core.permission(closing.token, { tool_name: 'TaskOutput' }), /Query mode/)
  assert.match(core.permission(closing.token, { tool_name: 'TaskStop' }), /Query mode/)
  await assert.rejects(() => core.tool(closing.token, 'regent_create_room', {}), /margen de cierre/)
  finish()
  await until(() => !core.active.size)
  const final = messages.find((text) => text.includes('Respuesta parcial del agente'))
  assert.ok(final.includes('Verified partial findings'))
  assert.equal(final.match(/escribe «?contin[uú]a»?/gi).length, 1)
  assert.match(interruptedText('Timeout.', ''), /No se obtuvo una respuesta parcial/)
  assert.equal(messages.filter((text) => text.includes('limite de tiempo')).length, 1)
  console.log(
    '  OK closing margin, one warning, blocked new tools, communication allowed and honest partial result',
  )
} finally {
  if (server) await new Promise((resolve) => server.close(resolve))
  if (core && !core.stopping) await core.close()
  if (durable) await durable.close()
  if (store) store.close()
  fs.rmSync(root, { recursive: true, force: true })
}
