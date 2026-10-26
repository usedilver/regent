import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ConfigSchema } from '../src/config.ts'
import { Core } from '../src/core/core.ts'
import { Store } from '../src/storage/store.ts'
import { Previews } from '../src/previews/manager.ts'
import { createHttp } from '../src/adapters/http.ts'
import { ExternalMcp } from '../src/adapters/mcp/server.ts'
import { mcpOutput } from '../src/adapters/mcp/output.ts'

test('MCP returns the current published preview independently of agent prose and hides unavailable URLs', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-preview-delivery-')))
  const store = new Store(':memory:')
  const token = 'p'.repeat(48)
  const config = ConfigSchema.parse({
    auth: { mode: 'indie' },
    repos: { path: root },
    slack: { workspace_team_id: 'T1', allowed_users: ['U1'] },
    mcp: {
      enabled: true,
      principals: [{ id: 'alice', token_env: 'REGENT_MCP_TOKEN_ALICE' }],
    },
  })
  const core = new Core({ config, store, cwd: root, output: mcpOutput(store) })
  const gateway = new ExternalMcp(core, { REGENT_MCP_TOKEN_ALICE: token })
  const server = createHttp(core, () => ({}), gateway)
  const app = http.createServer((req, res) => res.end('fixture app'))
  const client = new Client({ name: 'preview-fixture', version: '1' })
  let now = Date.now()
  let listening = true
  const processInfo = { cwd: root, start: 'fixture-start', group: 42 }
  const killed = []
  let previews

  try {
    app.listen(0, '127.0.0.1')
    await once(app, 'listening')
    const port = app.address().port
    await new Promise((resolve) => app.close(resolve))
    const previewConfig = {
      domain: 'preview.example.invalid',
      port_min: port,
      port_max: port,
      ttl_minutes: 5,
      max_active: 1,
    }
    const manager = () =>
      new Previews(
        store,
        previewConfig,
        (pid) => (pid === 42 ? processInfo : null),
        (pid) => killed.push(pid),
        () => now,
        () => listening,
      )
    const run = (key) => {
      const { runId } = store.accept(
        {
          adapter: 'mcp',
          eventId: key,
          key,
          author: 'mcp:alice',
          channel: key,
          text: 'Dame un preview',
          intent: 'task',
        },
        root,
        24,
      )
      store.finish(runId, 'completed', 'El agente omitio el enlace.', '')
      return runId
    }
    const runId = run('mcp:alice:preview')
    const otherRunId = run('mcp:alice:other')
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    )
    const status = async (id = runId) => {
      const response = await client.callTool({
        name: 'regent_get_run',
        arguments: { run_id: id, wait_ms: 0 },
      })
      assert.ok(!response.isError)
      return JSON.parse(response.content[0].text)
    }

    assert.equal((await status()).preview, null)
    assert.equal((await status()).preview_available, false)
    core.previews = previews = manager()
    assert.equal((await status()).preview, null)
    assert.equal((await status()).preview_available, true)
    const reserved = await previews.reserve('mcp:alice:preview', root)
    assert.deepEqual((await status()).preview, {
      ready: false,
      url: null,
      expires_at: reserved.expires_at,
    })
    app.listen(port, '127.0.0.1')
    await once(app, 'listening')
    const published = await previews.publish('mcp:alice:preview', 42)
    const ready = await status()
    assert.deepEqual(ready.preview, {
      ready: true,
      url: published.url,
      expires_at: published.expires_at,
    })
    assert.equal(ready.run.result, 'El agente omitio el enlace.')
    assert.deepEqual(Object.keys(ready.preview).sort(), ['expires_at', 'ready', 'url'])
    assert.equal((await status(otherRunId)).preview, null)
    assert.throws(() => gateway.status('mcp:bob', runId), /no autorizada/)

    previews.close()
    core.previews = previews = manager()
    assert.equal((await status()).preview.url, published.url)
    listening = false
    assert.equal((await status()).preview.ready, false)
    assert.equal((await status()).preview.url, null)
    listening = true
    now += 6 * 60 * 1000
    assert.equal((await status()).preview.ready, false)
    assert.equal((await status()).preview.url, null)
    previews.stop('mcp:alice:preview')
    assert.equal((await status()).preview, null)
    assert.deepEqual(killed, [42])
  } finally {
    await client.close()
    previews?.close()
    await core.close()
    if (server.listening) await new Promise((resolve) => server.close(resolve))
    if (app.listening) await new Promise((resolve) => app.close(resolve))
    store.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
