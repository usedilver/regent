import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { Store } from '../src/storage/store.ts'
import { ConfigSchema } from '../src/config.ts'
import { createRuntime, runtimePort } from '../src/runtime.ts'
import { httpLifecycle } from '../src/adapters/http-lifecycle.ts'

async function freePort() {
  const server = net.createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-runtime-')))
const output = { async notice() {}, async status() {}, async delta() {}, async finish() {} }
const config = (previewPort) =>
  ConfigSchema.parse({
    auth: { mode: 'indie' },
    repos: { path: directory },
    slack: { workspace_team_id: 'T1', allowed_users: ['U1'] },
    mcp: { enabled: true, principals: [{ id: 'fixture', token_env: 'REGENT_MCP_TOKEN_FIXTURE' }] },
    previews: { domain: 'preview.example.invalid', listen_port: previewPort },
  })
process.env.REGENT_MCP_TOKEN_FIXTURE = 'fixture-token-'.repeat(4)

for (const mode of ['slack', 'mcp']) {
  test(`${mode} runtime closes HTTP, preview gateway and SQLite exactly once`, async () => {
    const previewPort = await freePort(),
      calls = []
    const store = new Store(':memory:')
    const slack =
      mode === 'slack'
        ? {
            output,
            connected: () => true,
            async start() {
              calls.push('start')
            },
            async stop() {
              calls.push('stop')
            },
          }
        : undefined
    const runtime = createRuntime(config(previewPort), {
      store,
      slack,
      port: 0,
      claudeVersion: 'fixture',
    })
    await runtime.start()
    const main = runtime.core.toolsUrl.replace('/tools', '/healthz')
    assert.equal((await (await fetch(main)).json()).db_ok, true)
    const gateway = `http://127.0.0.1:${previewPort}/`
    assert.equal((await fetch(gateway)).status, 404)
    const closing = runtime.close()
    assert.equal(runtime.close(), closing)
    await closing
    assert.equal(runtime.core.stopping, true)
    assert.equal(runtime.core.previews, undefined)
    await assert.rejects(fetch(main))
    await assert.rejects(fetch(gateway))
    assert.throws(() => store.db.prepare('SELECT 1'), /not open|closed/)
    assert.deepEqual(calls, mode === 'slack' ? ['start', 'stop'] : [])
  })
}

test('failed Slack startup closes all resources and preserves the startup error', async () => {
  const previewPort = await freePort(),
    store = new Store(':memory:')
  let stops = 0
  const runtime = createRuntime(config(previewPort), {
    store,
    port: 0,
    claudeVersion: 'fixture',
    slack: {
      output,
      connected: () => false,
      async start() {
        throw new Error('fixture startup failed')
      },
      async stop() {
        stops++
      },
    },
  })
  await assert.rejects(runtime.start(), /fixture startup failed/)
  await runtime.close()
  assert.equal(stops, 1)
  assert.equal(runtime.server.listening, false)
  await assert.rejects(fetch(`http://127.0.0.1:${previewPort}/`))
  assert.throws(() => store.db.prepare('SELECT 1'), /not open|closed/)
})

test('failed Slack shutdown still closes the other resources', async () => {
  const previewPort = await freePort(),
    store = new Store(':memory:')
  const runtime = createRuntime(config(previewPort), {
    store,
    port: 0,
    claudeVersion: 'fixture',
    slack: {
      output,
      connected: () => true,
      async start() {},
      async stop() {
        throw new Error('fixture stop failed')
      },
    },
  })
  await runtime.start()
  await assert.rejects(runtime.close(), AggregateError)
  assert.equal(runtime.server.listening, false)
  await assert.rejects(fetch(`http://127.0.0.1:${previewPort}/`))
  assert.throws(() => store.db.prepare('SELECT 1'), /not open|closed/)
})

test('HTTP shutdown also destroys upgraded sockets', async () => {
  const server = http.createServer()
  server.on('upgrade', (request, socket) =>
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n',
    ),
  )
  const lifecycle = httpLifecycle(server)
  await lifecycle.listen(0)
  const socket = net.connect(server.address().port, '127.0.0.1')
  try {
    socket.write(
      'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n',
    )
    await once(socket, 'data')
    const disconnected = once(socket, 'close')
    await lifecycle.close()
    await disconnected
    assert.equal(server.listening, false)
  } finally {
    socket.destroy()
    await lifecycle.close()
  }
})

test('invalid MCP configuration releases the SQLite runtime claim', async () => {
  const store = new Store(':memory:')
  const previous = process.env.REGENT_MCP_TOKEN_FIXTURE
  delete process.env.REGENT_MCP_TOKEN_FIXTURE
  try {
    assert.throws(
      () => createRuntime(config(8791), { store, port: 0, claudeVersion: 'fixture' }),
      /REGENT_MCP_TOKEN_FIXTURE/,
    )
    assert.throws(() => store.db.prepare('SELECT 1'), /not open|closed/)
  } finally {
    process.env.REGENT_MCP_TOKEN_FIXTURE = previous
  }
})

test('an occupied main port closes the preview gateway without affecting its listener', async () => {
  const foreign = http
    .createServer((req, res) => res.end('existing service'))
    .listen(0, '127.0.0.1')
  await once(foreign, 'listening')
  const previewPort = await freePort(),
    store = new Store(':memory:')
  const runtime = createRuntime(config(previewPort), {
    store,
    port: foreign.address().port,
    claudeVersion: 'fixture',
  })
  try {
    await assert.rejects(runtime.start(), /EADDRINUSE/)
    await assert.rejects(fetch(`http://127.0.0.1:${previewPort}/`))
    assert.equal(
      await (await fetch(`http://127.0.0.1:${foreign.address().port}/`)).text(),
      'existing service',
    )
    assert.throws(() => store.db.prepare('SELECT 1'), /not open|closed/)
  } finally {
    await new Promise((resolve) => foreign.close(resolve))
  }
})

test('main port validation rejects invalid ports and preview collisions', () => {
  const previews = config(8791).previews
  assert.equal(runtimePort(undefined, previews), 8788)
  for (const value of ['', '0', '-1', '65536', '1.2', 'abc', '8791', '32001']) {
    assert.throws(() => runtimePort(value, previews), /REGENT_PORT/)
  }
  assert.equal(runtimePort('9000', previews), 9000)
})

process.on('exit', () => fs.rmSync(directory, { recursive: true, force: true }))
