import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ConfigSchema } from '../../src/config.ts'
import { Core } from '../../src/core/core.ts'
import { Store } from '../../src/storage/store.ts'
import { createHttp } from '../../src/adapters/http.ts'
import { ExternalMcp } from '../../src/adapters/mcp/server.ts'
import { startPreviewServer } from '../../src/previews/server.ts'
import { isolationFor } from '../../src/core/repository.ts'

if (process.env.REGENT_SMOKE !== '1' || !process.env.REGENT_SMOKE_PREVIEW_DOMAIN) {
  throw new Error(
    'Opt-in: REGENT_SMOKE=1 REGENT_SMOKE_PREVIEW_DOMAIN=<gateway domain> node test/smoke/visual-delivery.mjs. Requires a dedicated public gateway listener and normal official CLI authentication; incurs provider usage.',
  )
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-visual-smoke-')))
const repo = path.join(root, 'repo')
const token = randomBytes(32).toString('hex')
const client = new Client({ name: 'visual-delivery-smoke', version: '1.0.0' })
let core
let store
let server
let stopGateway
let conversation

try {
  fs.mkdirSync(repo)
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/worktrees/\npreview.log\n')
  fs.writeFileSync(
    path.join(repo, 'CLAUDE.md'),
    'This is an isolated synthetic frontend fixture. Use only this repository and its built-in Node app. No subagents, commits, PRs, package installation or external services. Start with setsid node server.mjs --port PORT </dev/null >preview.log 2>&1 & and preserve its PID when a runtime is needed. Readiness checks must be bounded. The navigation in index.html and the /d/match/registros handler in server.mjs are independent; remove both when deleting that screen. Other pages must keep working.\n',
  )
  const original =
    '<!doctype html><html><body><nav><a href="/">Inicio</a><a href="/d/match/registros">Match</a></nav><h1>Inicio</h1></body></html>\n'
  fs.writeFileSync(path.join(repo, 'index.html'), original)
  fs.writeFileSync(
    path.join(repo, 'server.mjs'),
    `import http from 'node:http'\nimport fs from 'node:fs'\nconst port = Number(process.argv[process.argv.indexOf('--port') + 1])\nhttp.createServer((req, res) => {\n  if (req.url === '/d/match/registros') { res.end('Registros'); return }\n  if (req.url !== '/') { res.writeHead(404); res.end('Not found'); return }\n  res.setHeader('content-type', 'text/html; charset=utf-8')\n  res.end(fs.readFileSync(new URL('index.html', import.meta.url)))\n}).listen(port, '127.0.0.1')\n`,
  )
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' })
  git('init', '-b', 'main')
  git('add', '.')
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Fixture',
  )
  store = new Store(path.join(root, 'state.sqlite'))
  store.claimRuntime()
  const config = ConfigSchema.parse({
    auth: { mode: 'indie' },
    repos: { path: root, default_repo: 'repo' },
    slack: { workspace_team_id: 'T1', allowed_users: [] },
    mcp: { enabled: true, principals: [{ id: 'fixture', token_env: 'REGENT_MCP_TOKEN_FIXTURE' }] },
    previews: {
      domain: process.env.REGENT_SMOKE_PREVIEW_DOMAIN,
      listen_port: Number(process.env.REGENT_SMOKE_GATEWAY_PORT ?? 8791),
      port_min: 32100,
      port_max: 32102,
      ttl_minutes: 5,
    },
    limits: {
      max_run_sec: { ask: 90, patch: 180, task: 180, project: 180 },
      stall_sec: 90,
      cancel_grace_sec: 5,
    },
  })
  core = new Core({
    store,
    config,
    cwd: root,
    runnerOverrides: { command: 'claude' },
    output: { async notice() {}, async status() {}, async delta() {}, async finish() {} },
  })
  const external = new ExternalMcp(core, { REGENT_MCP_TOKEN_FIXTURE: token })
  server = createHttp(core, () => ({}), external)
  stopGateway = await startPreviewServer(core)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = `http://127.0.0.1:${server.address().port}`
  core.toolsUrl = address + '/tools'
  await client.connect(
    new StreamableHTTPClientTransport(new URL(address + '/mcp'), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  )
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 })
    assert.ok(!result.isError, JSON.stringify(result.content))
    return result.structuredContent ?? JSON.parse(result.content[0].text)
  }
  const accepted = await call('regent_start', {
    request_id: randomUUID(),
    intent: 'patch',
    prompt:
      'Borra la vista /d/match/registros y su enlace del menú, ya no me es útil. Conserva Inicio. No hagas commits ni PR.',
  })
  conversation = accepted.conversation_id
  let result
  const deadline = Date.now() + 210000
  do {
    assert.ok(Date.now() < deadline, 'Real provider smoke deadline exceeded')
    result = await call('regent_get_run', { run_id: accepted.run_id, wait_ms: 20000 })
  } while (['queued', 'running', 'cancel_requested'].includes(result.latest_run.state))
  const run = result.latest_run
  const assessment = store.lastEvent(run.id, 'review_assessment')
  const checks = store.db
    .prepare("SELECT count(*) AS n FROM events WHERE run_id=? AND kind='review_check'")
    .get(run.id).n
  const retries = store.db
    .prepare("SELECT count(*) AS n FROM events WHERE run_id=? AND kind='review_retry'")
    .get(run.id).n
  console.log(
    JSON.stringify({
      state: run.state,
      delivery: run.delivery,
      assessment,
      checks,
      retries,
      cost_usd: run.cost_usd,
    }),
  )
  assert.equal(run.state, 'completed', run.error || run.result)
  assert.equal(run.delivery?.state, 'ready', run.result)
  assert.ok(run.result.includes(run.delivery.url), 'MCP result must contain the link')
  assert.equal(assessment.kind, 'required')
  assert.ok(checks > 0, 'The real official CLI must execute the native Stop hook')
  assert.ok(retries <= 2, 'Corrective continuations must be bounded')
  const response = await fetch(run.delivery.url)
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.ok(html.includes('Inicio'))
  assert.ok(!html.includes('/d/match/registros'))
  assert.equal((await fetch(run.delivery.url + '/d/match/registros')).status, 404)
  assert.equal(fs.readFileSync(path.join(repo, 'index.html'), 'utf8'), original)
  const isolated = isolationFor(repo, conversation).dir
  assert.ok(
    !fs.readFileSync(path.join(isolated, 'index.html'), 'utf8').includes('/d/match/registros'),
  )
  console.log(
    'PASS real CLI + MCP: frontend deletion automatically published a public HTTPS preview, returned its URL, preserved Inicio and removed the route without changing source.',
  )
} finally {
  await core?.close()
  if (conversation) core?.previews?.stop(conversation)
  await client.close().catch(() => {})
  await stopGateway?.()
  if (server) await new Promise((resolve) => server.close(resolve))
  store?.close()
  fs.rmSync(root, { recursive: true, force: true })
}
