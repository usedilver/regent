import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { slackImageLoader, imageReference } from '../src/slack-images.ts'
import { prepareImages, IMAGE_BYTES } from '../src/images.ts'
import { gatherHistory } from '../src/slack.ts'
import { History } from '../src/history.ts'
import { Store } from '../src/store.ts'
import { runnerInput, runnerArgs, startRunner } from '../src/runner.ts'
import { Core } from '../src/core.ts'
import { ConfigSchema } from '../src/config.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
const reference = { id: 'F123', name: 'capture.png' }
const signal = new AbortController().signal
let requests = 0, body = png
let file = { ...reference, mimetype: 'image/png', url_private: 'https://files.slack.com/files-pri/T1-F123/capture.png' }
const loader = slackImageLoader(async (method, args) => { assert.equal(method, 'files.info'); assert.equal(args.file, 'F123'); return { file } }, 'SYNTHETIC_SLACK_TOKEN', async (url, opts) => {
  requests++; assert.equal(url.hostname, 'files.slack.com'); assert.equal(opts.headers.authorization, 'Bearer SYNTHETIC_SLACK_TOKEN'); assert.equal(opts.redirect, 'error')
  return new Response(body, { headers: { 'content-type': 'application/octet-stream' } })
})
assert.deepEqual(imageReference(file), reference)
assert.equal(imageReference({ id: 'F2', mimetype: 'application/pdf' }), undefined)
assert.equal((await loader(reference, signal)).mediaType, 'image/png')
assert.equal((await loader(reference, signal)).data, png.toString('base64'))
for (const url of ['https://example.com/a.png', 'http://files.slack.com/a.png', 'https://files.slack.com.evil.test/a.png', 'https://user:pass@files.slack.com/a.png']) {
  file.url_private = url; const before = requests
  await assert.rejects(loader(reference, signal), /autorizado/); assert.equal(requests, before)
}
file.url_private = 'https://files.slack.com/a.png'
body = Buffer.from('<html>login</html>'); await assert.rejects(loader(reference, signal), /invalida/)
body = Buffer.alloc(IMAGE_BYTES + 1); await assert.rejects(loader(reference, signal), /3 MiB/)
body = Buffer.from(png); body.writeUInt32BE(8001, 16); await assert.rejects(loader(reference, signal), /dimensiones/)
body = png
const abort = new AbortController(); abort.abort()
await assert.rejects(loader(reference, abort.signal))
const redirect = slackImageLoader(async () => ({ file }), 'token', async () => new Response(null, { status: 302 }))
await assert.rejects(redirect(reference, signal), /HTTP 302/)
const forbidden = slackImageLoader(async () => ({ file }), 'token', async () => new Response(null, { status: 403 }))
await assert.rejects(forbidden(reference, signal), /HTTP 403/)

const image = { mediaType: 'image/png', data: png.toString('base64') }
const items = Array.from({ length: 7 }, (_, i) => ({ messageId: `C1:${i}:image:F${i}`, reference: { id: `F${i}`, name: 'capture.png' }, label: `@U${i}: image` }))
let loads = 0
const limited = await prepareImages(items, async () => { loads++; return image }, signal)
assert.equal(limited.images.length, 5); assert.equal(loads, 5); assert.equal(limited.skipped.size, 2)
loads = 0
const duplicate = await prepareImages([items[0], items[0]], async () => { loads++; return image }, signal)
assert.equal(loads, 1); assert.equal(duplicate.images.length, 1)
assert.equal((await prepareImages([items[0]], undefined, signal)).skipped.size, 1)
const budget = await prepareImages(items.slice(0, 4), async () => ({ mediaType: 'image/png', data: Buffer.alloc(IMAGE_BYTES).toString('base64') }), signal)
assert.equal(budget.images.length, 3); assert.equal(budget.skipped.size, 1)
file.is_external = true
await assert.rejects(loader(reference, signal), /no disponible/)
delete file.is_external
const slowAbort = new AbortController()
const slow = slackImageLoader(async () => new Promise(() => {}), 'token')
const waiting = slow(reference, slowAbort.signal)
slowAbort.abort()
await assert.rejects(waiting)

// Earlier thread image + image pasted with the trigger; image-only DMs also load.
const slackMessages = [{ ts: '1', user: 'U1', text: 'Previous screenshot', files: [file] }, { ts: '2', thread_ts: '1', user: 'U2', text: '<@BOT> compare', files: [{ ...file, id: 'F456', name: 'second.png' }] }]
const api = async () => ({ messages: slackMessages })
const gathered = await gatherHistory(api, { channel: 'C1', thread: '1', latest: '2', trigger: 'C1:2' }, 'BOT', async () => 'text file')
assert.equal(gathered.filter(m => m.image).length, 2)
assert.match(gathered.find(m => m.image?.id === 'F123').text, /@U1/)
const dm = await gatherHistory(async () => ({ messages: [{ ts: '3', user: 'U1', files: [file] }] }), { channel: 'D1', latest: '3' }, 'BOT', async () => '')
assert.equal(dm[0].image.id, 'F123')
const methods = []
await gatherHistory(async method => { methods.push(method); return { messages: method === 'conversations.history' ? [{ ts: '1', user: 'U1', reply_count: 1 }] : slackMessages } }, { channel: 'C1', latest: '2' }, 'BOT', async () => '')
assert.deepEqual(methods, ['conversations.history', 'conversations.replies'])

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'regent-images-'))
const db = path.join(root, 'test.sqlite')
let store = new Store(db)
const key = 'slack:C1:1'
const inbound = id => ({ adapter: 'slack', eventId: id, key, author: 'U2', team: 'T1', channel: 'C1', thread: '1', text: 'compare', history: { channel: 'C1', thread: '1', latest: '2', trigger: 'C1:2' } })
try {
  const first = store.accept(inbound('one'), root, 24)
  let prepared = await new History(store).prepare(first.runId, key, null, async () => gathered)
  assert.equal(prepared.images[0].reference.id, 'F456', 'current message image has priority')
  const snapshot = store.db.prepare('SELECT snapshot FROM run_history WHERE run_id=?').get(first.runId).snapshot
  assert.ok(!snapshot.includes('url_private') && !snapshot.includes(image.data) && !snapshot.includes('SYNTHETIC_SLACK_TOKEN'))
  store.close(); store = new Store(db)
  prepared = await new History(store).prepare(first.runId, key, null, async () => { throw new Error('snapshot should survive restart') })
  assert.equal(prepared.images.length, 2)
  prepared.acknowledge('session', new Set(['C1:1:image:F123']))
  const second = store.accept(inbound('two'), root, 24)
  const pending = await new History(store).prepare(second.runId, key, 'session', async () => gathered)
  assert.deepEqual(pending.images.map(i => i.reference.id), ['F123'], 'failed downloads must retry')
  pending.acknowledge('session')
  assert.equal((await new History(store).prepare(second.runId, key, 'session')).images.length, 0)
  assert.equal((await new History(store).prepare(second.runId, key, null)).images.length, 2, 'fresh sessions replay images')

  const opts = { cwd: root, prompt: 'Inspect the screenshot', images: [{ ...image, label: '@U1 screenshot' }], runId: 'test', sessionId: 'resume-id', token: 'internal', toolsUrl: 'http://127.0.0.1:1/tools', readonlyMcp: [], timeoutMs: 2000, stallMs: 1000, graceMs: 20, onEvent() {} }
  const input = JSON.parse(runnerInput(opts))
  assert.equal(input.message.content[1].source.data, image.data)
  assert.ok(runnerArgs(opts).includes('--input-format') && runnerArgs(opts).includes('--resume'))
  assert.equal(runnerInput({ prompt: 'text only' }), 'text only')
  const script = `let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{const m=JSON.parse(input);console.log(JSON.stringify({type:'result',result:m.message.content[1].source.media_type,is_error:false}))})`
  const result = await startRunner({ ...opts, command: process.execPath, prefixArgs: ['-e', script, '--'] }).done
  assert.equal(result.state, 'completed'); assert.equal(result.text, 'image/png')

  const memory = new Store(':memory:'); let received
  const core = new Core({ store: memory, config: ConfigSchema.parse({ auth: { mode: 'indie' }, repos: { path: root }, slack: { workspace_team_id: 'T1', allowed_users: ['U2'] } }), cwd: root,
    output: Object.fromEntries(['notice', 'status', 'delta', 'finish'].map(k => [k, async () => {}])),
    runner: options => { received = options; options.onEvent({ kind: 'init', sessionId: 'visual-session' }); return { done: Promise.resolve({ state: 'completed', text: 'ok', error: '', cost: 0, usage: {} }), cancel() {} } } })
  try {
    core.historyLoader = async () => gathered; core.imageLoader = async () => image
    await core.submit(inbound('core'))
    while (core.active.size) await Promise.allSettled([...core.active.values()].map(a => a.done))
    assert.equal(received.images.length, 2)
    assert.match(received.images.find(i => i.label.includes('F123')).label, /@U1/)
    assert.ok(!received.prompt.includes(image.data))
  } finally { await core.close(); memory.close() }
} finally { store.close(); fs.rmSync(root, { recursive: true, force: true }) }
console.log('Images: Slack thread/DM/channel, authenticated bounds, snapshots, dedupe, retry, core and CLI input passed')
