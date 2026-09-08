import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/v2/store.ts'
import { Core } from '../src/v2/core.ts'
import { ConfigSchema } from '../src/v2/config.ts'
import { gatherHistory } from '../src/v2/slack.ts'
import { History } from '../src/v2/history.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'regent-history-'))
const db = path.join(root, 'history.sqlite')
const key = 'slack:C1:1'
const input = (ts, text) => ({ adapter: 'slack', eventId: `message:C1:${ts}`, key, channel: 'C1', thread: '1', team: 'T1', author: 'U1', text,
  history: { channel: 'C1', thread: '1', latest: ts, trigger: `C1:${ts}` } })
const until = async fn => { for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)) } throw new Error('Timed out') }
const config = ConfigSchema.parse({ auth: { mode: 'indie' }, repos: { path: root }, slack: { workspace_team_id: 'T1', allowed_users: ['U1'] } })
let messages = [{ id: 'C1:1', text: '@U1: Question' }], store, core
const starts = []
let reads = 0
function open() {
  store = new Store(db)
  core = new Core({ store, config, cwd: root,
    output: { async notice() {}, async status() {}, async delta() {}, async finish() {} },
    runner: options => {
      options.onEvent({ kind: 'init', sessionId: options.sessionId ?? `session-${starts.length}` })
      let resolve
      const done = new Promise(r => { resolve = r })
      const finish = (state = 'completed') => resolve({ state, text: 'Answer', error: '', cost: 0, usage: {} })
      starts.push({ options, finish })
      return { done, cancel: () => finish('interrupted') }
    } })
  core.historyLoader = async source => {
    reads++
    return messages.filter(m => !source.latest || Number(m.id.split(':')[1]) <= Number(source.latest))
  }
}
async function close() { await core.close(); store.close() }

try {
  open()
  await core.submit(input('1', 'Question'))
  await until(() => starts.length === 1)
  assert.equal(starts[0].options.prompt.match(/Question/g).length, 1)
  messages.push(...Array.from({ length: 5 }, (_, i) => ({ id: `C1:${i + 2}`, text: `@member-${i}: intermediate-${i}` })))
  messages.push({ id: 'C1:7', text: '@U1: Apply' }, { id: 'C1:8', text: '@U1: Continue' })
  messages.push(messages[1])
  await core.submit(input('7', 'Apply'))
  const duplicate = await core.submit(input('7', 'Apply'))
  assert.equal(duplicate.duplicate, true)
  await core.submit(input('8', 'Continue'))
  starts[0].finish()
  await until(() => starts.length === 2)
  for (let i = 0; i < 5; i++) assert.equal(starts[1].options.prompt.match(new RegExp(`intermediate-${i}`, 'g')).length, 1)
  assert.doesNotMatch(starts[1].options.prompt, /Continue/)
  starts[1].finish()
  await until(() => starts.length === 3)
  assert.doesNotMatch(starts[2].options.prompt, /intermediate-|Question|@U1: Apply/)
  starts[2].finish()
  await until(() => !core.active.size)
  assert.equal(reads, 3)
  await close()

  open()
  messages = messages.filter(m => m.id !== 'C1:3')
  messages.push({ id: 'C1:3', text: '@member: corrected requirement' }, { id: 'C1:9', text: '@U1: Review' })
  await core.submit(input('9', 'Review'))
  await until(() => starts.length === 4)
  assert.match(starts[3].options.prompt, /corrected requirement/)
  assert.doesNotMatch(starts[3].options.prompt, /intermediate-/)
  starts[3].finish()
  await until(() => !core.active.size)
  messages.push({ id: 'C1:10', text: '@member: not acknowledged' })
  await core.submit(input('10', 'not acknowledged'))
  await until(() => starts.length === 5)
  await close()
  open()
  messages.push({ id: 'C1:11', text: '@U1: Retry' })
  await core.submit(input('11', 'Retry'))
  await until(() => starts.length === 6)
  assert.match(starts[5].options.prompt, /not acknowledged/)
  assert.doesNotMatch(starts[5].options.prompt, /corrected requirement|intermediate-/)
  starts[5].finish()
  await until(() => !core.active.size)
  // A new Claude session must receive the full relevant snapshot again.
  await core.submit({ ...input('reset', 'reset'), history: undefined })
  messages.push({ id: 'C1:12', text: '@U1: Start again' })
  await core.submit(input('12', 'Start again'))
  await until(() => starts.length === 7)
  assert.match(starts[6].options.prompt, /corrected requirement|intermediate-/)
  starts[6].finish()
  await until(() => !core.active.size)
  await close()
  console.log('  OK five intermediate messages, queued overlap, retries, edited messages, restart and session reset')

  open()
  messages.push({ id: 'C1:13', text: '@U2: Queued context' }, { id: 'C1:14', text: '@U1: Queued request' })
  const queued = store.accept(input('14', 'Queued request'), root, 24)
  await new History(store).prepare(queued.runId, key, store.conversation(key).session_id, core.historyLoader)
  await close()
  open()
  const snapshotLoader = core.historyLoader
  core.historyLoader = async () => { throw new Error('The persisted snapshot must be used') }
  await core.recover()
  await until(() => starts.length === 8)
  assert.match(starts[7].options.prompt, /Queued context/)
  starts[7].finish()
  await until(() => !core.active.size)
  core.historyLoader = snapshotLoader
  const loader = core.historyLoader
  core.historyLoader = async () => { throw new Error('missing_scope') }
  messages.push({ id: 'C1:15', text: '@U2: Recover this context' }, { id: 'C1:16', text: '@U1: Failed fetch' })
  const failed = await core.submit(input('16', 'Failed fetch'))
  await until(() => !core.active.size)
  assert.equal(store.run(failed.runId).state, 'failed')
  core.historyLoader = loader
  messages.push({ id: 'C1:17', text: '@U1: Retry fetch' })
  await core.submit(input('17', 'Retry fetch'))
  await until(() => starts.length === 9)
  assert.match(starts[8].options.prompt, /Recover this context|Failed fetch/)
  starts[8].finish()
  await until(() => !core.active.size)
  await close()
  console.log('  OK queued work survives restart and failed fetch never advances delivered history')

  // Channel history includes fresh replies under old roots and excludes the bot's own output.
  const calls = []
  const api = async (method, args) => {
    calls.push({ method, args })
    if (method === 'conversations.history') return !args.cursor
      ? { messages: [{ ts: '8', user: 'BOT', text: 'Own response' }, { ts: '7', user: 'U2', text: 'New root', files: [{ id: 'F1' }] }], response_metadata: { next_cursor: 'next' } }
      : { messages: [{ ts: '1', user: 'U1', text: 'Old root', reply_count: 2 }] }
    return { messages: [{ ts: '1', user: 'U1', text: 'Old root' }, { ts: '6', thread_ts: '1', user: 'U3', text: 'Fresh reply' }, { ts: '10', user: 'U4', text: 'Future' }] }
  }
  const history = await gatherHistory(api, { channel: 'C1', latest: '9' }, 'BOT', async () => 'Attachment content')
  assert.equal(history.filter(m => m.id === 'C1:1').length, 1)
  assert.ok(history.some(m => m.text.includes('Fresh reply')))
  assert.ok(history.some(m => m.id === 'C1:7:files' && m.text.includes('Attachment content')))
  assert.ok(!history.some(m => /Future|Own response/.test(m.text)))
  const fresh = await gatherHistory(api, { channel: 'C1', latest: '9' }, 'BOT', async () => '', undefined, true)
  assert.ok(fresh.some(m => m.text.includes('Own response')))
  assert.ok(calls.every(c => c.args.latest === '9' && c.args.inclusive))
  await assert.rejects(() => gatherHistory(async () => { throw new Error('missing_scope') }, { channel: 'private', thread: '1' }, 'BOT', async () => ''), /missing_scope/)
  await assert.rejects(() => gatherHistory(async () => ({ messages: [], response_metadata: { next_cursor: 'same' } }), { channel: 'C1' }, 'BOT', async () => ''), /cursor/)
  await assert.rejects(() => gatherHistory(api, { channel: 'C1' }, 'BOT', async () => '', AbortSignal.abort()), /abort/i)
  console.log('  OK paginated channels, replies under old roots, attachments, bot exclusion and explicit API failures')
} finally {
  if (core && !core.stopping) await close()
  fs.rmSync(root, { recursive: true, force: true })
}
