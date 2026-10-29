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
import { mcpActivities } from '../src/adapters/mcp/activities.ts'

const until = async (condition) => {
  const end = Date.now() + 5000
  while (!condition()) {
    if (Date.now() > end) throw new Error('Timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('queue, model status, heartbeat, retries and partial prose stay in activities; final and blocking errors reach Slack', async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-quiet-')))
  const store = new Store(':memory:')
  const calls = []
  const slack = new SlackOutput(async (method, args) => {
    calls.push({ method, args })
    return { ts: String(calls.length) }
  })
  slack.store = store
  slack.activities = new SlackActivities(slack.api, store)
  const output = new DurableOutput(store, slack)
  const handles = []
  const core = new Core({
    store,
    output,
    cwd: directory,
    config: ConfigSchema.parse({
      auth: { mode: 'indie' },
      repos: { path: directory },
      slack: { workspace_team_id: 'T', allowed_users: ['U'] },
      limits: { max_concurrent_runs: 1 },
    }),
    runner: (opts) => {
      let finish
      const done = new Promise((resolve) => {
        finish = resolve
      })
      const handle = {
        opts,
        finish,
        done,
        cancel() {
          finish({ state: 'interrupted', text: '', error: 'stopped', cost: 0, usage: {} })
        },
      }
      handles.push(handle)
      opts.onEvent({ kind: 'init', sessionId: `session-${handles.length}` })
      return handle
    },
  })
  const input = (id) => ({
    adapter: 'slack',
    key: `slack:C:${id}`,
    eventId: id,
    channel: 'C',
    thread: id,
    team: 'T',
    author: 'U',
    text: 'Review the request',
  })
  try {
    const first = await core.submit(input('1'))
    await until(() => handles.length === 1)
    const second = await core.submit(input('2'))
    assert.match(
      mcpActivities(store, store.run(second.runId)).tasks.find((t) => t.id === 'progress').title,
      /En cola/,
    )
    const active = core.active.get('slack:C:1')
    await core.tool(active.token, 'regent_status', {
      text: 'Revisando los datos',
      phase: 'investigation',
    })
    core.refreshProgress(active, true)
    handles[0].opts.onEvent({ kind: 'text_delta', text: 'Estoy trabajando.\n' })
    handles[0].opts.onEvent({
      kind: 'api_retry',
      attempt: 1,
      error: { message: 'temporary network error' },
    })
    await active.output
    await slack.activities.flush()
    assert.match(
      mcpActivities(store, store.run(first.runId)).tasks.find((t) => t.id === 'progress').title,
      /Reintentando/,
    )
    assert.equal(calls.filter((c) => c.method === 'chat.postMessage').length, 0)
    assert.equal(
      calls.some((c) => c.args.markdown_text),
      false,
    )
    assert.equal(
      store.db.prepare("SELECT count(*) n FROM deliveries WHERE kind='notice'").get().n,
      0,
    )
    handles[0].finish({
      state: 'completed',
      text: 'Resultado verificado',
      error: '',
      cost: 0,
      usage: {},
    })
    await until(() => handles.length === 2)
    await until(() => calls.some((c) => c.args.text === 'Resultado verificado'))
    assert.doesNotMatch(
      mcpActivities(store, store.run(second.runId)).tasks.find((t) => t.id === 'progress').title,
      /En cola/,
    )
    handles[1].finish({
      state: 'failed',
      text: '',
      error: "You've hit your usage limit",
      cost: 0,
      usage: {},
      failure: { source: 'claude', code: 'usage_limit', detail: "You've hit your usage limit" },
    })
    await until(() => !core.active.size)
    const posts = calls.filter((c) => c.method === 'chat.postMessage')
    assert.equal(posts.length, 2)
    assert.equal(posts[0].args.text, 'Resultado verificado')
    assert.match(posts[1].args.text, /cuota/)
  } finally {
    await core.close()
    await output.close()
    store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
