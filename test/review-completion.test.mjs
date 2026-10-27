import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { Core } from '../src/core/core.ts'
import { Store } from '../src/storage/store.ts'
import { ConfigSchema } from '../src/config.ts'
import { isolationFor } from '../src/core/repository.ts'
import { createHttp } from '../src/adapters/http.ts'
import { ExternalMcp } from '../src/adapters/mcp/server.ts'
import { ReviewAssessment } from '../src/core/review.ts'

test('verification accepts only parseable paths on the reserved host', () => {
  for (const route of ['//outside.example/', '//[invalid', '/\\outside.example/', '/path#fragment'])
    assert.equal(
      ReviewAssessment.safeParse({ kind: 'verified', reason: 'Checked', path: route }).success,
      false,
    )
  assert.equal(
    ReviewAssessment.safeParse({ kind: 'verified', reason: 'Checked', path: '/report?period=week' })
      .success,
    true,
  )
})

const until = async (predicate) => {
  const limit = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > limit) throw new Error('Fixture timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function fixture(t, { query = false, enabled = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-review-')))
  const store = new Store(':memory:')
  const replies = []
  let finish
  const core = new Core({
    cwd: root,
    store,
    config: ConfigSchema.parse({
      auth: { mode: 'indie' },
      repos: { path: root },
      slack: { workspace_team_id: 'T', allowed_users: [] },
      mcp: {
        enabled: true,
        principals: [{ id: 'fixture', token_env: 'REGENT_MCP_TOKEN_FIXTURE' }],
      },
    }),
    output: {
      async notice() {},
      async status() {},
      async delta() {},
      async finish(c, run, text) {
        replies.push(text)
      },
    },
    runner: () => {
      const done = new Promise((resolve) => {
        finish = (text = 'Cambio preparado.') =>
          resolve({ state: 'completed', text, error: '', cost: 0, usage: {} })
      })
      return { done, cancel: () => finish() }
    },
  })
  const app = http.createServer((req, res) => {
    if (req.url === '/missing') {
      res.writeHead(404)
      return res.end('missing')
    }
    if (req.url === '/login-required') {
      res.writeHead(307, { location: '/login' })
      return res.end()
    }
    res.end('synthetic app')
  })
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${app.address().port}`
  const preview = { id: 'fixture', pid: 42, process_start: 'start-one' }
  let reserved = false
  let ready = false
  if (enabled) {
    core.previews = {
      get: () => (reserved ? preview : undefined),
      result: () => ({ ready, url, expires_at: new Date(Date.now() + 300000).toISOString() }),
      async reserve() {
        reserved = true
        return { ready: false, url }
      },
      async publish() {
        reserved = true
        ready = true
        return this.result()
      },
    }
  }
  const accepted = await core.submit({
    adapter: 'mcp',
    author: 'mcp:fixture',
    key: 'mcp:fixture:test',
    channel: 'fixture',
    eventId: 'first',
    intent: query ? 'ask' : 'patch',
    text: query ? 'Explica el proyecto' : 'Borra una pantalla',
  })
  await until(() => finish)
  const active = [...core.active.values()][0]
  if (!query) fs.mkdirSync(isolationFor(root, active.run.conversation_key).dir, { recursive: true })
  const server = createHttp(core, () => ({}))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  core.toolsUrl = `http://127.0.0.1:${server.address().port}/tools`
  const mcp = new ExternalMcp(core, {
    REGENT_MCP_TOKEN_FIXTURE: 'fixture-token-00000000000000000000000',
  })
  const assess = (kind, extra = {}) =>
    core.tool(active.token, 'regent_status', {
      text: 'Validando el cambio',
      review: { kind, reason: 'Fixture assessment', ...extra },
    })
  t.after(async () => {
    await core.close()
    await new Promise((resolve) => server.close(resolve))
    await new Promise((resolve) => app.close(resolve))
    store.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    core,
    store,
    active,
    url,
    preview,
    assess,
    status: () => mcp.status('mcp:fixture', accepted.runId),
    async finish() {
      finish()
      await until(() => !core.active.size)
      return { reply: replies.at(-1), status: mcp.status('mcp:fixture', accepted.runId) }
    },
  }
}

test('ordinary operational work finishes without a preview obligation or rewritten response', async (t) => {
  const f = await fixture(t)
  const result = await f.finish()
  assert.equal(result.reply, 'Cambio preparado.')
  assert.equal(result.status.run.delivery, undefined)
  assert.equal(f.store.lastEvent(f.active.run.id, 'review_retry'), undefined)
})

test('a running process never becomes a client review URL without an executor verification', async (t) => {
  const f = await fixture(t)
  await f.core.tool(f.active.token, 'regent_preview', { action: 'reserve' })
  await f.core.tool(f.active.token, 'regent_preview', { action: 'publish', pid: 42 })
  assert.equal(f.status().preview.process_ready, true)
  assert.equal(f.status().preview.ready, false)
  assert.equal(f.status().preview.verified, false)
  assert.equal(f.status().preview.url, null)
  const result = await f.finish()
  assert.equal(result.status.run.delivery, undefined)
  assert.equal(result.reply, 'Cambio preparado.')
})

test('verified exact path is exposed independently of prose and survives progress throttling', async (t) => {
  const f = await fixture(t)
  await f.core.tool(f.active.token, 'regent_preview', { action: 'publish', pid: 42 })
  f.active.lastStatusAt = Date.now()
  const receipt = await f.assess('verified', { path: '/requested?period=2026' })
  assert.equal(receipt.review.url, f.url + '/requested?period=2026')
  assert.equal(receipt.review.http_status, 200)
  const result = await f.finish()
  assert.equal(result.status.run.delivery.state, 'reported')
  assert.equal(result.status.run.delivery.verification, 'executor')
  assert.equal(result.status.preview.url, f.url + '/requested?period=2026')
  assert.equal(result.status.preview.verified, true)
  assert.equal(result.reply, 'Cambio preparado.', 'presentation remains executor-owned')
})

test('a wrong route fails despite a healthy root, and a failed recheck invalidates earlier evidence', async (t) => {
  const f = await fixture(t)
  await f.core.tool(f.active.token, 'regent_preview', { action: 'publish', pid: 42 })
  await f.assess('verified', { path: '/requested' })
  await assert.rejects(f.assess('verified', { path: '/missing' }), /HTTP 404/)
  assert.equal(f.status().preview.url, null)
  const result = await f.finish()
  assert.equal(result.status.run.delivery.state, 'blocked')
  assert.equal(result.status.run.delivery.url, undefined)
})

test('a login redirect is transport metadata only and never triggers verification by itself', async (t) => {
  const f = await fixture(t)
  await f.core.tool(f.active.token, 'regent_preview', { action: 'publish', pid: 42 })
  assert.equal(f.status().preview.url, null)
  const receipt = await f.assess('verified', {
    path: '/login-required',
    reason:
      'Executor checked the target using an authorized browser session; anonymous access redirects as expected.',
  })
  assert.equal(receipt.review.http_status, 307)
  assert.equal(receipt.review.verification, 'executor')
  await f.finish()
})

test('an executor-reported blocker withdraws earlier verification without erasing the report', async (t) => {
  const f = await fixture(t)
  await f.core.tool(f.active.token, 'regent_preview', { action: 'publish', pid: 42 })
  await f.assess('verified', { path: '/requested' })
  await f.assess('blocked', { reason: 'The required data source is unavailable.' })
  assert.equal(f.status().preview.verified, false)
  assert.equal(f.status().preview.url, null)
  const result = await f.finish()
  assert.equal(result.status.run.delivery.state, 'blocked')
  assert.equal(result.reply, 'Cambio preparado.')
})

test('proof is tied to a process identity and rejects replacement processes and external paths', async (t) => {
  const f = await fixture(t)
  await f.core.tool(f.active.token, 'regent_preview', { action: 'publish', pid: 42 })
  await assert.rejects(f.assess('verified', { path: '//outside.example/' }))
  await f.assess('verified', { path: '/requested' })
  f.preview.process_start = 'a-new-process'
  assert.equal(f.status().preview.verified, false)
  assert.equal(f.status().preview.url, null)
  await f.finish()
})

test('legacy review assessments remain optional reports with no forced retries or lost outcomes', async (t) => {
  for (const kind of ['required', 'blocked', 'not_applicable', 'external']) {
    const f = await fixture(t)
    await f.assess(kind, kind === 'external' ? { url: 'https://deployment.example/review' } : {})
    const result = await f.finish()
    assert.equal(result.reply, 'Cambio preparado.')
    assert.equal(
      result.status.run.delivery.state,
      kind === 'required' ? 'missing' : kind === 'external' ? 'reported' : kind,
    )
    assert.equal(f.store.lastEvent(f.active.run.id, 'review_retry'), undefined)
  }
})

test('query permissions and authenticated legacy completion endpoint remain enforced', async (t) => {
  const f = await fixture(t, { query: true })
  await assert.rejects(f.assess('verified', { path: '/' }), /Query/)
  const endpoint = f.core.toolsUrl.replace('/tools', '/completion-check')
  assert.equal((await fetch(endpoint, { method: 'POST', body: '{}' })).status, 401)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${f.active.token}` },
    body: '{}',
  })
  assert.deepEqual(await response.json(), { decision: 'allow' })
  const result = await f.finish()
  assert.equal(result.status.run.delivery, undefined)
})
