import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { startRunner } from '../src/execution/runner.ts'
import { Core } from '../src/core/core.ts'
import { ConfigSchema } from '../src/config.ts'
import { Store } from '../src/storage/store.ts'
import { DurableOutput } from '../src/storage/delivery.ts'
import { SlackOutput } from '../src/adapters/slack/output.ts'
import { replyPayloads } from '../src/adapters/slack/format.ts'

const report = '# Resultado\n\nSe encontraron tres dependencias que deben migrarse.'
const acknowledgement = 'Análisis entregado y memoria actualizada.'
const assistant = (id, text, extra = {}) => ({
  type: 'assistant',
  message: { id, content: [{ type: 'text', text }] },
  ...extra,
})
const delta = (text, extra = {}) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  ...extra,
})
const result = (text) => ({ type: 'result', result: text, total_cost_usd: 0 })
const edit = {
  type: 'assistant',
  message: {
    content: [{ type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: '/fixture' } }],
  },
}
const edited = {
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: 'edit', content: 'Updated' }] },
}
const incident = (text = report) => [
  delta(text),
  assistant('report', text),
  edit,
  edited,
  delta(acknowledgement),
  assistant('closing', acknowledgement),
  result(acknowledgement),
]

function fixture(t, events) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-reply-')))
  const script = `const events = ${JSON.stringify(events)};
console.log(JSON.stringify({type:'system',subtype:'init',session_id:'fixture',mcp_servers:[]}));
for (const event of events) console.log(JSON.stringify(event));`
  const options = {
    cwd: root,
    prompt: 'Review the fixture',
    runId: 'fixture',
    toolsUrl: 'http://127.0.0.1:1/tools',
    token: 'synthetic',
    readonlyMcp: [],
    command: process.execPath,
    prefixArgs: ['-e', script, '--'],
    timeoutMs: 5000,
    stallMs: 2000,
    graceMs: 30,
    onEvent() {},
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, options }
}

test('report → memory tool → acknowledgement preserves the report exactly once', async (t) => {
  const { options } = fixture(t, incident())
  const reply = await startRunner(options).done
  assert.equal(reply.state, 'completed', reply.error)
  assert.equal(reply.text, `${report}\n\n${acknowledgement}`)
})

test('completed assistant messages work without partial streaming', async (t) => {
  const { options } = fixture(
    t,
    incident().filter((event) => event.type !== 'stream_event'),
  )
  assert.equal((await startRunner(options).done).text, `${report}\n\n${acknowledgement}`)
})

test('a normal streamed final is not duplicated', async (t) => {
  const { options } = fixture(t, [delta(report), assistant('report', report), result(report)])
  assert.equal((await startRunner(options).done).text, report)
})

test('multiple text blocks and cumulative snapshots preserve order without duplicates', async (t) => {
  const first = 'Primera parte.'
  const second = 'Segunda parte.'
  const completed = {
    type: 'assistant',
    message: {
      id: 'multi',
      content: [
        { type: 'text', text: first },
        { type: 'text', text: second },
      ],
    },
  }
  const { options } = fixture(t, [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'multi' } } },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: first },
      },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    },
    delta(second),
    completed,
    completed,
    result(`${first}\n\n${second}`),
  ])
  assert.equal((await startRunner(options).done).text, `${first}\n\n${second}`)
})

test('a background continuation cannot replace an earlier answer with a short final', async (t) => {
  const { options } = fixture(t, [
    delta(report),
    assistant('report', report),
    result(report),
    assistant('replay', 'PRIVATE_REPLAY', { isReplay: true }),
    edit,
    edited,
    delta(acknowledgement),
    assistant('closing', acknowledgement),
    result(acknowledgement),
  ])
  assert.equal((await startRunner(options).done).text, `${report}\n\n${acknowledgement}`)
})

test('thinking, tool results and subagent prose never enter the reply', async (t) => {
  const { options } = fixture(t, [
    {
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'PRIVATE_REASONING' }] },
    },
    delta('PRIVATE_SUBAGENT', { parent_tool_use_id: 'agent' }),
    assistant('child', 'PRIVATE_SUBAGENT', { parent_tool_use_id: 'agent' }),
    {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'query', content: 'PRIVATE_TOOL' }],
      },
    },
    ...incident(),
  ])
  assert.equal((await startRunner(options).done).text, `${report}\n\n${acknowledgement}`)
})

test('stream-only output keeps earlier text when the result is shorter', async (t) => {
  const { options } = fixture(t, [
    delta(report),
    edit,
    edited,
    delta(acknowledgement),
    result(acknowledgement),
  ])
  const reply = await startRunner(options).done
  assert.ok(reply.text.includes(report))
  assert.equal(reply.text.split(acknowledgement).length - 1, 1)
})

test('final error text is preserved alongside earlier findings', async (t) => {
  const { options } = fixture(t, [
    delta(report),
    assistant('report', report),
    { ...result('Provider unavailable'), is_error: true, errors: ['Provider unavailable'] },
  ])
  const reply = await startRunner(options).done
  assert.equal(reply.state, 'failed')
  assert.equal(reply.text, `${report}\n\nProvider unavailable`)
})

async function until(predicate) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Reply delivery timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('the full reply survives durable Slack pagination, network failure and restart', async (t) => {
  const longReport = report + '\n\n' + 'Hallazgo verificable. '.repeat(800)
  const secret = 'sk-ant-synthetic-reply-secret'
  const { root, options } = fixture(t, incident(`${longReport}\n${secret}`))
  const database = path.join(root, 'test.sqlite')
  let store = new Store(database)
  const posts = []
  let offline = true
  const api = async (method, args) => {
    if (method !== 'chat.postMessage') return {}
    if (offline && posts.length === 1) throw new Error('synthetic network failure')
    posts.push(args)
    return { ts: `receipt-${posts.length}` }
  }
  const slack = new SlackOutput(api)
  slack.store = store
  let output = new DurableOutput(store, slack)
  const core = new Core({
    store,
    output,
    cwd: root,
    config: ConfigSchema.parse({
      auth: { mode: 'indie' },
      repos: { path: root },
      slack: { workspace_team_id: 'T', allowed_users: ['U'] },
    }),
    runnerOverrides: {
      command: options.command,
      prefixArgs: options.prefixArgs,
      stallMs: options.stallMs,
    },
  })
  t.after(async () => {
    await core.close()
    await output.close()
    store.close()
  })
  const accepted = await core.submit({
    adapter: 'slack',
    eventId: 'incident',
    key: 'slack:C:1',
    channel: 'C',
    thread: '1',
    author: 'U',
    team: 'T',
    text: 'Review the fixture',
  })
  await until(() => !core.active.size)
  await output.flush()
  const run = store.run(accepted.runId)
  assert.ok(run.result.includes(longReport), 'The persisted reply must include the full report')
  assert.ok(run.result.includes('[REDACTED]'))
  assert.ok(!run.result.includes(secret))
  assert.equal(
    store.db.prepare("SELECT state FROM deliveries WHERE kind='finish'").get().state,
    'pending',
  )
  assert.equal(posts.length, 1)
  await core.close()
  await output.close()
  store.close()

  store = new Store(database)
  const resumed = new SlackOutput(api)
  resumed.store = store
  output = new DurableOutput(store, resumed)
  offline = false
  await output.flush()
  assert.deepEqual(
    posts.map((post) => post.text),
    replyPayloads(run.result).map((page) => page.text),
  )
  assert.ok(posts.every((post) => post.channel === 'C' && post.thread_ts === '1'))
  assert.equal(
    store.db.prepare("SELECT state FROM deliveries WHERE kind='finish'").get().state,
    'sent',
  )
})
