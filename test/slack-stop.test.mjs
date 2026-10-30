import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Core } from '../src/core/core.ts'
import { ConfigSchema } from '../src/config.ts'
import { Store } from '../src/storage/store.ts'
import { DurableOutput } from '../src/storage/delivery.ts'
import { SlackOutput } from '../src/adapters/slack/output.ts'
import { SlackActivities } from '../src/adapters/slack/activities.ts'
import { mcpOutput, routeMcpOutput } from '../src/adapters/mcp/output.ts'

const until = async (condition) => {
  const deadline = Date.now() + 5000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Stop regression timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const input = (eventId, text = 'Review the request') => ({
  adapter: 'slack',
  key: 'slack:C:1',
  channel: 'C',
  thread: '1',
  team: 'T',
  author: 'U',
  eventId,
  text,
})

function fixture(t, stoppedResult) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-stop-')))
  const store = new Store(':memory:')
  const calls = []
  const slack = new SlackOutput(async (method, args) => {
    calls.push({ method, args })
    return { ts: String(calls.length) }
  })
  slack.store = store
  slack.activities = new SlackActivities(slack.api, store)
  const output = new DurableOutput(store, routeMcpOutput(slack, mcpOutput(store)))
  const handles = []
  const core = new Core({
    store,
    output,
    cwd: directory,
    config: ConfigSchema.parse({
      auth: { mode: 'indie' },
      repos: { path: directory },
      slack: { workspace_team_id: 'T', allowed_users: ['U'] },
    }),
    runner: (options) => {
      let finish
      const done = new Promise((resolve) => {
        finish = resolve
      })
      const handle = {
        options,
        finish,
        done,
        cancel() {
          finish(stoppedResult)
        },
      }
      handles.push(handle)
      options.onEvent({ kind: 'init', sessionId: 'fixture-session' })
      return handle
    },
  })
  t.after(async () => {
    await core.close()
    await output.close()
    store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return { core, store, slack, output, calls, handles }
}

for (const stoppedResult of [
  { state: 'interrupted', text: '', error: 'stopped', cost: 0, usage: {} },
  { state: 'interrupted', text: 'Partial findings', error: 'stopped', cost: 0, usage: {} },
  { state: 'failed', text: 'Provider error', error: 'Prompt is too long', cost: 0, usage: {} },
]) {
  test(`user stop stays in the existing Slack card (${stoppedResult.state}, ${stoppedResult.text || 'no partial'})`, async (t) => {
    const f = fixture(t, stoppedResult)
    const accepted = await f.core.submit(input('first'))
    await until(() => f.handles.length === 1)
    const active = f.core.active.get(input('').key)
    await active.output
    await f.slack.activities.flush()
    const receipt = f.slack.activities.get(accepted.runId).ts
    const queued = await f.core.submit(input('queued', 'Review next'))
    f.calls.length = 0
    await f.core.submit(input('stop', 'stop'))
    await until(() => !f.core.active.size)
    await f.output.flush()
    assert.equal(f.calls.filter((c) => c.method === 'chat.postMessage').length, 0)
    assert.equal(f.store.run(accepted.runId).state, 'interrupted')
    assert.equal(f.store.run(accepted.runId).result, stoppedResult.text)
    assert.match(f.store.run(accepted.runId).error, /Detenido por el usuario/)
    assert.equal(f.store.run(queued.runId).state, 'queued')
    assert.equal(f.store.conversation(input('').key).session_id, 'fixture-session')
    assert.equal(f.slack.activities.get(accepted.runId).ts, receipt)
    assert.equal(f.slack.activities.get(accepted.runId).state.terminal, 'interrupted')
    assert.equal(
      f.calls.filter((c) => c.method === 'agents.sessions.setStatus').at(-1).args.status,
      'active',
    )
    f.calls.length = 0
    f.core.refreshProgress(active, true)
    await active.output
    await f.core.submit(input('stop-again', 'stop'))
    assert.equal(f.calls.filter((c) => c.method === 'chat.postMessage').length, 0)
    assert.equal(f.handles.length, 1)
  })
}

test('stopping during Slack history loading is silent too', async (t) => {
  const f = fixture(t)
  let loading = false
  f.core.historyLoader = async () => {
    loading = true
    return new Promise(() => {})
  }
  const accepted = await f.core.submit({
    ...input('history'),
    history: { channel: 'C', thread: '1' },
  })
  await until(() => loading)
  f.calls.length = 0
  await f.core.submit(input('stop', 'stop'))
  await until(() => !f.core.active.size)
  await f.output.flush()
  assert.equal(f.store.run(accepted.runId).state, 'interrupted')
  assert.equal(f.handles.length, 0)
  assert.equal(f.calls.filter((c) => c.method === 'chat.postMessage').length, 0)
})

test('an executor-initiated cancellation still delivers its reason', async (t) => {
  const f = fixture(t, { state: 'interrupted', text: '', error: 'stopped', cost: 0, usage: {} })
  await f.core.submit(input('first'))
  await until(() => f.handles.length === 1)
  const active = f.core.active.get(input('').key)
  await f.core.tool(active.token, 'regent_cancel', { reason: 'Required repository is unavailable' })
  await until(() => !f.core.active.size)
  assert.match(
    f.calls.find((c) => c.method === 'chat.postMessage').args.text,
    /Required repository/,
  )
})

test('durable replay retains silent user cancellation across a store restart', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'regent-stop-replay-'))
  const file = path.join(directory, 'state.sqlite')
  let store = new Store(file)
  const accepted = store.accept(input('first'), directory)
  store.start(accepted.runId)
  store.finish(accepted.runId, 'interrupted', 'Saved findings', 'Detenido por el usuario.')
  const failed = new DurableOutput(store, {
    async finish() {
      throw new Error('synthetic transport failure')
    },
  })
  await assert.rejects(
    failed.finish(store.conversation(input('').key), store.run(accepted.runId), 'Saved findings', {
      userStopped: true,
    }),
    /synthetic transport failure/,
  )
  store.close()
  store = new Store(file)
  const calls = []
  const slack = new SlackOutput(async (method) => {
    calls.push(method)
    return { ts: 'replay' }
  })
  slack.store = store
  const output = new DurableOutput(store, routeMcpOutput(slack, mcpOutput(store)))
  try {
    await output.flush()
    assert.equal(store.pendingDeliveries(), 0)
    assert.equal(calls.includes('chat.postMessage'), false)
    assert.equal(store.run(accepted.runId).result, 'Saved findings')
  } finally {
    await output.close()
    store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a failed cancellation delivery does not create a fallback Slack notice', async () => {
  const store = new Store(':memory:')
  const accepted = store.accept(input('first'), process.cwd())
  store.start(accepted.runId)
  store.finish(accepted.runId, 'interrupted', '', 'Detenido por el usuario.')
  const notices = []
  const output = new DurableOutput(store, {
    async finish() {
      throw new SyntaxError('synthetic permanent delivery failure')
    },
    async notice(_conversation, text) {
      notices.push(text)
    },
  })
  try {
    await output.finish(store.conversation(input('').key), store.run(accepted.runId), '', {
      userStopped: true,
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(store.pendingDeliveries(), 0)
    assert.deepEqual(notices, [])
  } finally {
    await output.close()
    store.close()
  }
})
