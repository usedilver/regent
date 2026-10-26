import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { Store } from '../src/storage/store.ts'
import { Previews } from '../src/previews/manager.ts'
import { launchPreview } from '../src/previews/launch.ts'

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-launch-test-')))
  const store = new Store(':memory:')
  const probe = net.createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const previews = new Previews(store, {
    domain: 'preview.example.com',
    port_min: port,
    port_max: port,
    max_active: 1,
    ttl_minutes: 5,
  })
  const reservation = await previews.reserve('test', root)
  fs.writeFileSync(
    path.join(root, 'server.mjs'),
    `import http from 'node:http'; http.createServer((req,res) => res.end('owned app')).listen(${port}, '127.0.0.1')`,
  )
  t.after(() => {
    previews.stop('test')
    store.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, previews, reservation, command: [process.execPath, 'server.mjs'] }
}

test('runtime launches and publishes an owned independent app, preserves it for review and stops only its group', async (t) => {
  const f = await fixture(t)
  const ready = await launchPreview(
    f.previews,
    'test',
    f.root,
    f.command,
    { PATH: process.env.PATH },
    new AbortController().signal,
  )
  assert.equal(ready.ready, true)
  assert.equal(f.previews.get('test').pid, ready.pid)
  assert.ok(f.previews.ownsProcess(f.previews.get('test')))
  assert.equal(fs.statSync(ready.log_file).mode & 0o777, 0o600)
  assert.equal(await (await fetch(`http://127.0.0.1:${ready.port}`)).text(), 'owned app')
  await assert.rejects(
    launchPreview(f.previews, 'test', f.root, f.command, {}, new AbortController().signal),
    /ya tiene un proceso/,
  )
  assert.equal(f.previews.result(f.previews.get('test')).ready, true)
  fs.rmSync(ready.log_file)
})

test('failed and aborted launches do not leave an owned listener or process reservation', async (t) => {
  const f = await fixture(t)
  await assert.rejects(
    launchPreview(
      f.previews,
      'test',
      path.dirname(f.root),
      f.command,
      {},
      new AbortController().signal,
    ),
    /worktree/,
  )
  const abort = new AbortController()
  const pending = launchPreview(
    f.previews,
    'test',
    f.root,
    [process.execPath, '-e', 'setInterval(()=>{},1000)'],
    {},
    abort.signal,
  )
  setTimeout(() => abort.abort(), 150)
  await assert.rejects(pending, /abort/i)
  assert.equal(f.previews.get('test'), undefined)
  fs.rmSync(
    path.join(
      os.tmpdir(),
      `regent-previews-${process.getuid?.() ?? 'local'}`,
      `${f.reservation.url.split('r-')[1].split('.')[0]}.log`,
    ),
    { force: true },
  )
})
