import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { Core } from '../src/core/core.ts'
import { Store } from '../src/storage/store.ts'
import { ConfigSchema } from '../src/config.ts'
import { isolationFor } from '../src/core/repository.ts'
import { createHttp } from '../src/adapters/http.ts'
import { completionCheck, setupSummary } from '../src/core/review.ts'
import { ExternalMcp } from '../src/adapters/mcp/server.ts'

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
  const app = http.createServer((req, res) => res.end('synthetic app'))
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${app.address().port}`
  const preview = { pid: 42 }
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
    assess,
    async finish() {
      finish()
      await until(() => !core.active.size)
      return { reply: replies.at(-1), status: mcp.status('mcp:fixture', accepted.runId) }
    },
    async hook(extraEnv = {}) {
      const child = execFile(
        process.execPath,
        [path.resolve('plugins/executor/hooks/completion.mjs')],
        {
          env: {
            ...process.env,
            REGENT_RUN_TOKEN: active.token,
            REGENT_TOOLS_URL: core.toolsUrl,
            ...extraEnv,
          },
        },
      )
      child.stdin.end(JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: true }))
      const chunks = []
      child.stdout.on('data', (chunk) => chunks.push(chunk))
      await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code) => (code ? reject(new Error('Hook failed')) : resolve()))
      })
      const output = chunks.join('').trim()
      return output ? JSON.parse(output) : undefined
    },
  }
}

test('Stop hook gives bounded feedback with non-secret environment evidence and final core detects omission', async (t) => {
  const f = await fixture(t)
  const dir = f.active.executionDir
  fs.writeFileSync(path.join(dir, '.worktreeinclude'), '.env.local\n')
  fs.writeFileSync(
    path.join(dir, '.env.local'),
    'HIRE_URL=https://example.invalid\nPASSWORD=secret-fixture-value\n',
  )
  assert.deepEqual(setupSummary(f.active), [
    { file: '.env.local', present: true, keys: 2, nonempty_keys: 2 },
  ])
  const first = await f.hook()
  assert.equal(first.decision, 'block')
  assert.match(first.reason, /nonempty_keys/)
  assert.doesNotMatch(first.reason, /secret-fixture-value/)
  assert.equal((await f.hook()).decision, 'block')
  assert.equal(await f.hook(), undefined)
  assert.equal(f.active.reviewRetries, 2)
  const result = await f.finish()
  assert.equal(result.status.run.delivery.state, 'missing')
  assert.match(result.status.run.result, /^Revision visual pendiente/)
  assert.match(result.reply, /^Revision visual pendiente/)
})

test('backend-only work and explicit user opt-outs can finish without launching a preview', async (t) => {
  const f = await fixture(t)
  await f.assess('not_applicable', {
    reason: 'Only internal code changed; no user-visible effect.',
  })
  assert.equal((await completionCheck(f.core, f.active)).decision, 'allow')
  assert.equal(f.active.previewAttempted, undefined)
  const result = await f.finish()
  assert.equal(result.status.run.delivery.state, 'not_applicable')
  assert.equal(result.reply, 'Cambio preparado.')
})

test('a claimed blocker without a preview attempt is not accepted as completed review', async (t) => {
  const f = await fixture(t)
  await f.assess('blocked', { reason: 'Environment looks empty after redacting values.' })
  assert.equal((await completionCheck(f.core, f.active)).decision, 'block')
  await f.core.tool(f.active.token, 'regent_preview', { action: 'reserve' })
  assert.equal((await completionCheck(f.core, f.active)).decision, 'block')
  await assert.rejects(f.core.tool(f.active.token, 'regent_preview', { action: 'publish' }), /PID/)
  assert.equal((await completionCheck(f.core, f.active)).decision, 'allow')
  const result = await f.finish()
  assert.equal(result.status.run.delivery.state, 'blocked')
  assert.match(result.reply, /^Revision visual pendiente/)
})

test('published preview is appended to both stored MCP result and final output even if the agent omits it', async (t) => {
  const f = await fixture(t)
  f.active.lastStatusAt = Date.now()
  await f.assess('required')
  assert.equal(f.active.review.kind, 'required', 'assessment must survive notice throttling')
  await f.core.tool(f.active.token, 'regent_preview', { action: 'reserve' })
  await f.core.tool(f.active.token, 'regent_preview', { action: 'publish', pid: 42 })
  assert.equal(await f.hook(), undefined)
  const result = await f.finish()
  assert.equal(result.status.run.delivery.state, 'ready')
  assert.equal(result.status.run.delivery.url, f.url)
  assert.ok(result.reply.includes(f.url))
  assert.ok(result.status.run.result.includes(f.url))
})

test('a preview from an earlier turn is not proof of delivery and an unreachable public URL stays pending', async (t) => {
  const f = await fixture(t)
  await f.assess('required')
  await f.core.tool(f.active.token, 'regent_preview', { action: 'publish', pid: 42 })
  f.active.previewPublished = false
  assert.equal((await completionCheck(f.core, f.active)).decision, 'block')
  f.active.previewPublished = true
  f.core.previews.result = () => ({ ready: true, url: 'http://127.0.0.1:1', expires_at: '' })
  const result = await f.finish()
  assert.equal(result.status.run.delivery.state, 'blocked')
  assert.equal(result.status.run.delivery.url, undefined)
  assert.match(result.reply, /^Revision visual pendiente/)
})

test('queries, disabled gateway, cancellation and closing deadlines never enter a retry loop', async (t) => {
  for (const options of [{ query: true }, { enabled: false }]) {
    const f = await fixture(t, options)
    assert.equal((await completionCheck(f.core, f.active)).decision, 'allow')
    assert.equal((await f.finish()).status.run.delivery, undefined)
  }
  const f = await fixture(t)
  f.active.wrapUpAt = Date.now() - 1
  assert.equal((await completionCheck(f.core, f.active)).decision, 'allow')
  f.active.cancelled = true
  assert.equal((await completionCheck(f.core, f.active)).decision, 'allow')
  assert.equal((await f.finish()).status.run.delivery, undefined)
})

test('verified deployment previews remain supported as agent-reported external links', async (t) => {
  const f = await fixture(t)
  const url = 'https://deployment.example.invalid/review'
  await f.assess('external', { url })
  assert.equal((await completionCheck(f.core, f.active)).decision, 'allow')
  const result = await f.finish()
  assert.equal(result.status.run.delivery.state, 'reported')
  assert.ok(result.reply.includes(url))
})

test('completion endpoint requires the active run token and rejects browser requests', async (t) => {
  const f = await fixture(t)
  const endpoint = f.core.toolsUrl.replace('/tools', '/completion-check')
  assert.equal((await fetch(endpoint, { method: 'POST', body: '{}' })).status, 401)
  assert.equal(
    (
      await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${f.active.token}`, origin: 'https://untrusted.invalid' },
        body: '{}',
      })
    ).status,
    403,
  )
  assert.equal(await f.hook({ REGENT_TOOLS_URL: 'http://127.0.0.1:1/tools' }), undefined)
})
