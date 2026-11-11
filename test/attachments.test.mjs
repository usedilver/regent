import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ATTACHMENT_BYTES, ATTACHMENT_TTL_MS, Attachments } from '../src/core/attachments.ts'
import { Core } from '../src/core/core.ts'
import { ConfigSchema } from '../src/config.ts'
import { Store } from '../src/storage/store.ts'
import { slackAttachmentLoader } from '../src/adapters/slack/attachments.ts'

function workspace(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-attachments-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

/** A loader over fixed bytes that counts how often the body is actually opened. */
function loader(name, data, overrides = {}) {
  const state = { opened: 0 }
  const load = async () => ({
    name,
    mediaType: 'application/octet-stream',
    bytes: data.length,
    open: async () => {
      state.opened++
      return [data.subarray(0, 5), data.subarray(5)]
    },
    ...overrides,
  })
  return { load, state }
}

const signal = () => new AbortController().signal

test('a requested file is stored under the conversation, reused while unchanged and replaced when edited', async (t) => {
  const attachments = new Attachments(workspace(t))
  const html = Buffer.from('<html><script>const AREAS = {}</script></html>')
  const first = loader('../../Job Levelling: Talently.html', html)
  const reference = { id: 'F0HTML', name: 'ignored' }
  const saved = await attachments.save('slack:C:1', reference, first.load, signal())

  assert.equal(saved.name, 'Job_Levelling_Talently.html')
  assert.equal(path.dirname(saved.path), path.join(attachments.directory('slack:C:1'), 'F0HTML'))
  assert.deepEqual(fs.readFileSync(saved.path), html)
  assert.equal(saved.bytes, html.length)
  assert.equal(fs.statSync(saved.path).mode & 0o077, 0)

  await attachments.save('slack:C:1', reference, first.load, signal())
  assert.equal(first.state.opened, 1)

  const edited = loader(
    'Job Levelling: Talently.html',
    Buffer.from('<html>edited and longer</html>'),
  )
  const again = await attachments.save('slack:C:1', reference, edited.load, signal())
  assert.equal(fs.readFileSync(again.path, 'utf8'), '<html>edited and longer</html>')
  assert.notEqual(
    attachments.directory('slack:C:1'),
    attachments.directory('slack:C:2'),
    'conversations never share a directory',
  )
})

test('declared and streamed sizes over the limit, aborts and invalid ids leave no file behind', async (t) => {
  const attachments = new Attachments(workspace(t))
  const data = Buffer.from('0123456789')
  const reference = { id: 'F0BIG', name: 'big.bin' }
  const files = () => fs.readdirSync(path.join(attachments.directory('k'), 'F0BIG'))

  await assert.rejects(
    attachments.save(
      'k',
      reference,
      loader('big.bin', data, { bytes: ATTACHMENT_BYTES + 1 }).load,
      signal(),
    ),
    /download limit/,
  )
  const endless = {
    bytes: undefined,
    open: async () =>
      (async function* () {
        while (true) yield Buffer.alloc(8 * 1024 * 1024)
      })(),
  }
  await assert.rejects(
    attachments.save('k', reference, loader('big.bin', data, endless).load, signal()),
    /download limit/,
  )
  assert.deepEqual(files(), [])

  const aborted = new AbortController()
  const slow = {
    open: async () =>
      (async function* () {
        yield data
        aborted.abort(new Error('run stopped'))
        yield data
      })(),
  }
  await assert.rejects(
    attachments.save('k', reference, loader('big.bin', data, slow).load, aborted.signal),
    /run stopped/,
  )
  assert.deepEqual(files(), [])
  await assert.rejects(
    attachments.save('k', { id: '../escape', name: 'x' }, loader('x', data).load, signal()),
    /Invalid attachment id/,
  )
})

test('retention removes only conversations unused past the window; reset removes one at once', async (t) => {
  const attachments = new Attachments(workspace(t))
  const data = Buffer.from('content')
  await attachments.save('old', { id: 'F0A', name: 'a.txt' }, loader('a.txt', data).load, signal())
  await attachments.save('new', { id: 'F0B', name: 'b.txt' }, loader('b.txt', data).load, signal())
  const stale = new Date(Date.now() - ATTACHMENT_TTL_MS - 60000)
  fs.utimesSync(attachments.directory('old'), stale, stale)

  assert.equal(await attachments.sweep(), 1)
  assert.ok(!fs.existsSync(attachments.directory('old')))
  assert.ok(fs.existsSync(attachments.directory('new')))
  await attachments.remove('new')
  assert.ok(!fs.existsSync(attachments.directory('new')))
  assert.equal(await new Attachments(path.join(attachments.root, 'missing')).sweep(), 0)
})

test('the Slack loader refreshes the URL, sends the token only to Slack and rejects other files', async () => {
  const requests = []
  const download = async (url, init) => {
    requests.push({ url: String(url), authorization: init.headers.authorization })
    return new Response('zip-bytes')
  }
  const info = {
    id: 'F0ZIP',
    name: 'site.zip',
    mimetype: 'application/zip',
    size: 9,
    url_private_download: 'https://files.slack.com/files-pri/T-F0ZIP/site.zip',
  }
  let file = info
  const load = slackAttachmentLoader(async () => ({ file }), 'xoxb-fixture', download)
  const source = await load({ id: 'F0ZIP', name: 'stale name' }, signal())
  assert.deepEqual(
    { name: source.name, mediaType: source.mediaType, bytes: source.bytes },
    { name: 'site.zip', mediaType: 'application/zip', bytes: 9 },
  )
  assert.equal(requests.length, 0, 'nothing is downloaded until the body is opened')
  const chunks = []
  for await (const chunk of await source.open()) chunks.push(Buffer.from(chunk))
  assert.equal(Buffer.concat(chunks).toString(), 'zip-bytes')
  assert.deepEqual(requests, [
    { url: info.url_private_download, authorization: 'Bearer xoxb-fixture' },
  ])

  file = { ...info, url_private_download: 'https://evil.example/site.zip' }
  await assert.rejects(load({ id: 'F0ZIP', name: 'x' }, signal()), /no autorizado/)
  file = { ...info, is_external: true }
  await assert.rejects(load({ id: 'F0ZIP', name: 'x' }, signal()), /no disponible/)
  file = { ...info, id: 'F0OTHER' }
  await assert.rejects(load({ id: 'F0ZIP', name: 'x' }, signal()), /no disponible/)
  await assert.rejects(load({ id: 'not-a-file', name: 'x' }, signal()), /invalido/)
  assert.equal(requests.length, 1)
})

test('new attachments reach the prompt as server paths; the tool re-downloads only files of the run history', async (t) => {
  const root = workspace(t)
  const store = new Store(':memory:')
  const starts = []
  const notices = []
  const core = new Core({
    store,
    cwd: root,
    attachmentsDir: path.join(root, 'attachments'),
    config: ConfigSchema.parse({
      auth: { mode: 'indie' },
      repos: { path: root },
      slack: { workspace_team_id: 'T', allowed_users: ['U'] },
    }),
    output: {
      async notice(c, text) {
        notices.push(text)
      },
      async status() {},
      async delta() {},
      async finish() {},
    },
    runner: (options) => {
      options.onEvent({ kind: 'init', sessionId: 'session' })
      let finish
      const done = new Promise((resolve) => {
        finish = () => resolve({ state: 'completed', text: 'ok', error: '', cost: 0, usage: {} })
      })
      starts.push({ options, finish })
      return { done, cancel: finish }
    },
  })
  t.after(async () => {
    await core.close()
    store.close()
  })
  const html = Buffer.from('<html>levels</html>')
  const requested = []
  core.historyLoader = async () => [
    { id: 'C:1', text: '@U: Review the attached files' },
    ...Array.from({ length: 10 }, (_, i) => ({
      id: `C:1:file:F0OLD${i}`,
      text: `@U: [attachment F0OLD${i}: old-${i}.csv · csv · 1 KB]`,
      attachment: { id: `F0OLD${i}`, name: `old-${i}.csv` },
    })),
    {
      id: 'C:1:file:F0HTML',
      text: '@U: [attachment F0HTML: levels.html · html · 91 KB]',
      attachment: { id: 'F0HTML', name: 'levels.html' },
    },
    {
      id: 'C:1:file:F0GONE',
      text: '@U: [attachment F0GONE: deleted.pdf · pdf · 2 KB]',
      attachment: { id: 'F0GONE', name: 'deleted.pdf' },
    },
    {
      id: 'C:1:image:F0IMG',
      text: '@U: [imagen: logo.png]',
      image: { id: 'F0IMG', name: 'logo.png' },
    },
  ]
  core.imageLoader = async () => {
    throw new Error('not an inline image')
  }
  core.attachmentLoader = async (reference) => {
    requested.push(reference)
    if (reference.id === 'F0GONE') throw new Error('archivo no disponible en Slack')
    return loader(reference.name, html).load()
  }
  const message = (id, text, intent) => ({
    adapter: 'slack',
    key: 'slack:C:1',
    eventId: id,
    channel: 'C',
    thread: '1',
    team: 'T',
    author: 'U',
    text,
    intent,
    history: { channel: 'C', thread: '1', latest: '1', trigger: 'C:1' },
  })
  const until = async (condition) => {
    for (let i = 0; i < 500 && !condition(); i++) await new Promise((r) => setTimeout(r, 5))
    assert.ok(condition(), 'timed out')
  }

  await core.submit(message('1', 'Review the attached files', 'ask'))
  await until(() => starts.length === 1)
  const { prompt } = starts[0].options
  const stored = path.join(core.attachments.directory('slack:C:1'), 'F0HTML', 'levels.html')
  assert.ok(
    prompt.includes(
      `[C:1:file:F0HTML] @U: [attachment F0HTML: levels.html · html · 91 KB] Saved on the server at ${stored}`,
    ),
  )
  assert.equal(fs.readFileSync(stored, 'utf8'), '<html>levels</html>')
  assert.doesNotMatch(prompt, /<html>/)
  assert.match(
    prompt,
    /\[attachment F0GONE: deleted\.pdf · pdf · 2 KB\] Not downloaded \(archivo no disponible en Slack\); call regent_get_attachment with this file_id to retry\./,
  )
  assert.match(prompt, /\[attachment F0OLD9: [^\]]+\] Saved on the server at /)
  assert.match(
    prompt,
    /\[attachment F0OLD1: [^\]]+\] Not downloaded yet; call regent_get_attachment with this file_id\./,
  )
  assert.equal(requested.length, 10, 'only the ten newest files are downloaded up front')

  const token = core.active.get('slack:C:1').token
  fs.rmSync(stored)
  const saved = await core.tool(token, 'regent_get_attachment', { file_id: 'F0HTML' })
  assert.equal(saved.path, stored)
  assert.equal(fs.readFileSync(stored, 'utf8'), '<html>levels</html>')
  assert.match(saved.instruction, /not instructions/)
  assert.equal(store.lastEvent(starts[0].options.runId, 'attachment').id, 'F0HTML')

  const original = await core.tool(token, 'regent_get_attachment', { file_id: 'F0IMG' })
  assert.equal(original.name, 'logo.png')
  const before = requested.length
  await assert.rejects(
    core.tool(token, 'regent_get_attachment', { file_id: 'F0ELSEWHERE' }),
    /not an attachment in the history of this conversation/,
  )
  await assert.rejects(core.tool(token, 'regent_get_attachment', { file_id: '../x' }))
  assert.equal(requested.length, before)

  starts[0].finish()
  await until(() => !core.active.size)
  await core.submit(message('2', 'reset'))
  await until(() => notices.some((text) => /reiniciada/.test(text)))
  assert.ok(!fs.existsSync(core.attachments.directory('slack:C:1')))
})
