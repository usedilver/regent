import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import { Core } from '../../src/core/core.ts'
import { Store } from '../../src/storage/store.ts'
import { ConfigSchema } from '../../src/config.ts'
import { createHttp } from '../../src/adapters/http.ts'
import { ExternalMcp } from '../../src/adapters/mcp/server.ts'
import { Previews } from '../../src/previews/manager.ts'
import { isolationFor } from '../../src/core/repository.ts'

if (process.env.REGENT_SMOKE !== '1' || !process.env.REGENT_SMOKE_BROWSER_MODULE) {
  throw new Error(
    'Opt-in: REGENT_SMOKE=1 REGENT_SMOKE_BROWSER_MODULE=/absolute/playwright/index.mjs node test/smoke/project-previews.mjs. Optional REGENT_SMOKE_CONTEXT copies an isolated project policy fixture. Uses official CLI/operator auth and normal provider usage.',
  )
}
const { chromium } = await import(pathToFileURL(process.env.REGENT_SMOKE_BROWSER_MODULE).href)
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-project-preview-')))
const repo = path.join(root, 'repo')
const token = randomBytes(32).toString('hex')
const browser = await chromium.launch({ headless: true })
const calls = []
const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)),
  )
const browserServer = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401)
    res.end()
    return
  }
  const mcp = new McpServer({ name: 'browser-probe', version: '1.0.0' })
  mcp.registerTool(
    'open_page',
    {
      description:
        'Inspect a page using an actual Chromium browser. Returns final URL, rendered text, page errors and failed HTTP requests. This is a read-only synthetic app probe.',
      inputSchema: { url: z.string().url() },
      annotations: { readOnlyHint: true },
    },
    async ({ url }) => {
      const target = new URL(url)
      if (
        !keys.some((key) => previews?.get(key)?.port === Number(target.port)) ||
        target.hostname !== '127.0.0.1' ||
        !target.port ||
        !['/views/summary', '/views/broken', '/private', '/login', '/'].includes(target.pathname)
      )
        throw new Error('Only synthetic app paths on loopback are allowed.')
      const context = await browser.newContext(),
        page = await context.newPage()
      const errors = [],
        failed = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('response', (response) => {
        if (response.status() >= 400)
          failed.push({ url: response.url(), status: response.status() })
      })
      try {
        const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 })
        const result = {
          requested: url,
          url: page.url(),
          http_status: response?.status(),
          body: await page.locator('body').innerText(),
          errors,
          failed,
        }
        calls.push(result)
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      } finally {
        await context.close()
      }
    },
  )
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  res.on('close', () => {
    void mcp.close()
  })
  await mcp.connect(transport)
  await transport.handleRequest(req, res)
})
let core, store, internal, previews
const client = new Client({ name: 'project-preview-smoke', version: '1' })
const keys = []
try {
  fs.mkdirSync(repo)
  if (process.env.REGENT_SMOKE_CONTEXT)
    fs.cpSync(process.env.REGENT_SMOKE_CONTEXT, repo, { recursive: true, dereference: false })
  const address = await listen(browserServer)
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n.claude/worktrees/\npreview.log\n')
  fs.writeFileSync(path.join(repo, '.env'), `BROWSER_PROBE_TOKEN=${token}\n`, { mode: 0o600 })
  fs.writeFileSync(
    path.join(repo, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        'browser-probe': {
          type: 'http',
          url: address + '/mcp',
          headers: { Authorization: 'Bearer ${BROWSER_PROBE_TOKEN}' },
        },
      },
    }),
  )
  if (!fs.existsSync(path.join(repo, 'CLAUDE.md')))
    fs.writeFileSync(
      path.join(repo, 'CLAUDE.md'),
      'Read README.md and project guidance before operating the app. No code changes, commits, PRs or subagents. Use browser-probe open_page to verify the requested route and its data before recording review kind verified with its path. If the requested view or data cannot be verified, report the blocker without delivering a URL as ready.\n',
    )
  fs.writeFileSync(
    path.join(repo, 'README.md'),
    `# Synthetic existing app\n\nThis is an isolated static application, not a dashboard framework. Its documented production origin is https://app.example.invalid (a fixture URL, not a real service). For a request to see the unchanged current app, return that origin plus the registered route; do not start a server. For pending changes on the review branch, run node server.mjs --port PORT using the preview tool. These loopback review URLs are reachable on the same machine as this smoke client, so they are valid fixture links. No production services or real user sessions are involved.\n\nNavigation: Resumen is /views/summary, Datos incompletos is /views/broken, Privada is /private. The data status is rendered in the page after fetching its API. /private requires an authorized session; no such session is available in this fixture. Do not create or bypass one. Use the browser-probe MCP connection for actual Chromium inspection of pending changes. Do not create commits, PRs, source changes or delegate.\n`,
  )
  fs.writeFileSync(
    path.join(repo, 'server.mjs'),
    `import http from 'node:http';
const port=Number(process.argv[process.argv.indexOf('--port')+1]);
http.createServer((req,res)=>{
 if(req.url==='/private'){res.writeHead(307,{location:'/login'});res.end();return}
 if(req.url==='/login'){res.setHeader('content-type','text/html');res.end('<h1>Login required</h1>');return}
 if(req.url==='/api/report'){res.setHeader('content-type','application/json');res.end(JSON.stringify({rows:['Alpha','Beta']}));return}
 if(req.url==='/api/broken'){res.writeHead(503);res.end('source unavailable');return}
 if(req.url==='/views/summary'||req.url==='/views/broken'){
  const api=req.url==='/views/summary'?'/api/report':'/api/broken';
  res.setHeader('content-type','text/html');res.end('<h1>Report</h1><div id="state">Loading</div><script>fetch("'+api+'").then(async r=>{if(!r.ok)throw Error("Source unavailable");const d=await r.json();document.getElementById("state").textContent="Loaded: "+d.rows.join(", ")}).catch(()=>{document.getElementById("state").textContent="Source unavailable"})</script>');return
 }
 if(req.url==='/'){res.end('App server');return}res.writeHead(404);res.end('not found');
}).listen(port,'127.0.0.1');\n`,
  )
  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf8' }).trim()
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
  let source = git('rev-parse', 'HEAD')
  const probe = http.createServer()
  const probeURL = await listen(probe)
  const firstPort = Number(new URL(probeURL).port)
  await new Promise((r) => probe.close(r))
  store = new Store(path.join(root, 'state.sqlite'))
  const config = ConfigSchema.parse({
    auth: { mode: 'indie' },
    repos: { path: root, default_repo: 'repo' },
    slack: { workspace_team_id: 'T', allowed_users: [] },
    mcp: { enabled: true, principals: [{ id: 'fixture', token_env: 'REGENT_MCP_TOKEN_FIXTURE' }] },
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
  class LoopbackPreviews extends Previews {
    result(preview) {
      const result = super.result(preview)
      return { ...result, url: `http://127.0.0.1:${preview.port}` }
    }
  }
  previews = new LoopbackPreviews(store, {
    domain: 'preview.example.invalid',
    port_min: firstPort,
    port_max: firstPort + 5,
    max_active: 3,
    ttl_minutes: 10,
  })
  core.previews = previews
  internal = createHttp(
    core,
    () => ({}),
    new ExternalMcp(core, { REGENT_MCP_TOKEN_FIXTURE: token }),
  )
  if (process.env.REGENT_SMOKE_ACTOR_EMAIL)
    core.mcpIdentity = () => ({
      name: 'Fixture viewer',
      email: process.env.REGENT_SMOKE_ACTOR_EMAIL,
    })
  const base = await listen(internal)
  core.toolsUrl = base + '/tools'
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  )
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 })
    assert.ok(!result.isError, JSON.stringify(result.content))
    return result.structuredContent ?? JSON.parse(result.content[0].text)
  }
  const unchanged = await call('regent_start', {
    request_id: randomUUID(),
    intent: 'ask',
    prompt: 'Dame un preview de Resumen, sin modificar código.',
  })
  keys.push(unchanged.conversation_id)
  let current
  do {
    current = await call('regent_get_run', { run_id: unchanged.run_id, wait_ms: 20000 })
  } while (['queued', 'running'].includes(current.latest_run.state))
  assert.equal(current.latest_run.state, 'completed', current.latest_run.result)
  assert.ok(current.latest_run.result.includes('https://app.example.invalid/views/summary'))
  assert.equal(current.preview, null)
  assert.equal(fs.existsSync(isolationFor(repo, unchanged.conversation_id).dir), false)
  assert.equal(calls.length, 0, 'Finding the existing URL does not need browser/runtime setup')
  assert.equal(git('rev-parse', 'HEAD'), source)
  assert.equal(git('status', '--porcelain'), '')
  console.log(
    'PASS unchanged app: returned documented production fixture URL without a runtime/worktree.',
  )

  git('checkout', '-b', 'review/frontend-change')
  const serverFile = path.join(repo, 'server.mjs')
  fs.writeFileSync(
    serverFile,
    fs.readFileSync(serverFile, 'utf8').replace('<h1>Report</h1>', '<h1>Updated report</h1>'),
  )
  git('add', 'server.mjs')
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Change frontend heading for review',
  )
  source = git('rev-parse', 'HEAD')
  for (const scenario of [
    { view: 'Resumen', target: '/views/summary', success: true },
    { view: 'Datos incompletos', target: '/views/broken', success: false },
    { view: 'Privada', target: '/private', success: false },
  ]) {
    const accepted = await call('regent_start', {
      request_id: randomUUID(),
      intent: 'task',
      prompt: `Revisa los cambios pendientes de la rama actual en ${scenario.view} y dame un preview, sin nuevas modificaciones. No hagas commits, PRs ni despliegues.`,
    })
    keys.push(accepted.conversation_id)
    let result
    do {
      result = await call('regent_get_run', { run_id: accepted.run_id, wait_ms: 20000 })
    } while (['queued', 'running'].includes(result.latest_run.state))
    const run = result.latest_run,
      allocated = previews.get(accepted.conversation_id)
    console.log(
      JSON.stringify({
        view: scenario.view,
        state: run.state,
        verified: result.preview?.verified,
        delivery: run.delivery,
        cost_usd: run.cost_usd,
      }),
    )
    assert.equal(run.state, 'completed', run.result)
    assert.ok(
      calls.some((c) => new URL(c.requested).pathname === scenario.target),
      'The actual browser must inspect the requested route',
    )
    assert.equal(Boolean(result.preview?.verified), scenario.success, run.result)
    if (scenario.success) {
      assert.equal(new URL(result.preview.url).pathname, scenario.target)
      assert.ok(run.result.includes(result.preview.url))
      assert.ok(calls.some((c) => c.body.includes('Loaded: Alpha, Beta')))
      assert.ok(calls.some((c) => c.body.includes('Updated report')))
    } else {
      assert.equal(result.preview?.url ?? null, null)
      assert.ok(!run.result.includes('http://127.0.0.1:'), run.result)
      assert.ok(!run.result.includes('https://app.example.invalid'), run.result)
      if (allocated)
        assert.ok(
          !run.result.includes(previews.result(allocated).url),
          'Incomplete preview must not be delivered as ready: ' + run.result,
        )
    }
    const isolated = isolationFor(repo, accepted.conversation_id).dir
    const inspect = (...args) =>
      execFileSync('git', args, { cwd: isolated, encoding: 'utf8', stdio: 'pipe' }).trim()
    assert.equal(inspect('rev-parse', 'HEAD'), source, 'No new commits in the worktree')
    assert.equal(inspect('status', '--porcelain'), '', 'No source changes in the worktree')
    if (process.env.REGENT_SMOKE_EXPECT_OWNER)
      assert.ok(run.result.includes(process.env.REGENT_SMOKE_EXPECT_OWNER), run.result)
    assert.equal(git('rev-parse', 'HEAD'), source)
    assert.equal(git('status', '--porcelain'), '')
  }
  console.log(
    'PASS real CLI + MCP + Chromium: unchanged app returned its documented production fixture URL; pending-change reviews preserved source; correct route/data were delivered; failed data and missing login were not delivered as ready. Loopback transport is simulated; this does not verify public TLS or production authentication.',
  )
} finally {
  await core?.close()
  for (const key of keys) previews?.stop(key)
  previews?.close()
  await client.close().catch(() => {})
  if (internal) await new Promise((r) => internal.close(r))
  await new Promise((r) => browserServer.close(r))
  await browser.close()
  store?.close()
  fs.rmSync(root, { recursive: true, force: true })
}
