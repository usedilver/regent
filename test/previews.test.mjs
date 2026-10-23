import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { ConfigSchema } from '../src/config.ts'
import { Store } from '../src/storage/store.ts'
import { Previews } from '../src/previews/manager.ts'
import { createPreviewHttp } from '../src/previews/http.ts'
import { Core } from '../src/core/core.ts'
import { createHttp } from '../src/adapters/http.ts'

const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-previews-')))
const listen = async (server) => {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}
const close = (server) => new Promise((resolve) => server.close(resolve))
const store = new Store(':memory:')
let seen
const authenticated = (request) =>
  request.headers.cookie?.includes('match_session=match-token') ||
  request.headers.authorization === 'Bearer app-token'
const app = http.createServer((req, res) => {
  seen = { headers: req.headers, url: req.url }
  if (req.url === '/private' && !authenticated(req)) {
    res.writeHead(401)
    return res.end('Application login required')
  }
  if (req.url === '/login') {
    res.writeHead(302, {
      location: '/private',
      'set-cookie': [
        'match_session=match-token; Domain=example.com; Path=/; Secure; HttpOnly',
        'csrf=app-csrf; Path=/; Secure',
      ],
    })
    return res.end()
  }
  if (req.url === '/restricted-origin' && req.headers.origin !== 'https://app.example.com') {
    res.writeHead(403)
    return res.end('Application origin policy')
  }
  res.end('Preview fixture')
})
app.on('upgrade', (req, socket) => {
  seen = { headers: req.headers, url: req.url }
  if (!authenticated(req))
    return socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
  socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n')
})
let gateway, previews
try {
  // Reserve a real free port, then let the fixture application occupy it.
  const probe = http.createServer()
  const port = await listen(probe)
  await close(probe)
  const config = ConfigSchema.parse({
    auth: { mode: 'indie' },
    repos: { path: directory },
    slack: { workspace_team_id: 'T1', allowed_users: ['U1'] },
    previews: {
      domain: 'preview.example.com',
      port_min: port,
      port_max: port + 3,
      max_active: 2,
      ttl_minutes: 5,
    },
  }).previews
  let now = Date.now(),
    processInfo = { cwd: directory, start: 'owned', group: 42 },
    killed = []
  previews = new Previews(
    store,
    config,
    (pid) => (pid === 42 ? processInfo : null),
    (pid) => killed.push(pid),
    () => now,
    () => true,
  )
  const first = await previews.reserve('one', directory)
  assert.equal(first.port, port)
  assert.equal(first.ready, false)
  const second = await previews.reserve('two', directory)
  assert.notEqual(first.port, second.port)
  await assert.rejects(() => previews.reserve('three', directory), /limite/)
  app.listen(port, '127.0.0.1')
  await once(app, 'listening')
  await assert.rejects(() => previews.publish('one', 99), /PID/)
  processInfo.cwd = path.dirname(directory)
  await assert.rejects(() => previews.publish('one', 42), /PID/)
  processInfo.cwd = directory
  const ready = await previews.publish('one', 42)
  assert.equal(ready.ready, true)
  assert.equal(previews.resolve(new URL(ready.url).hostname).pid, 42)
  assert.equal(previews.resolve('r-unknown.preview.example.com'), undefined)
  assert.equal(previews.resolve('localhost'), undefined)
  console.log(
    '  OK preview allocation, capacity, ownership checks, publication and exact host routing',
  )
  gateway = createPreviewHttp(previews)
  const gatewayPort = await listen(gateway)
  const host = new URL(ready.url).hostname
  const request = (headers = {}, suffix = '/') =>
    new Promise((resolve, reject) => {
      http
        .get(
          { hostname: '127.0.0.1', port: gatewayPort, path: suffix, headers: { host, ...headers } },
          (res) => {
            const chunks = []
            res.on('data', (c) => chunks.push(c))
            res.on('end', () =>
              resolve({
                status: res.statusCode,
                headers: res.headers,
                text: Buffer.concat(chunks).toString(),
              }),
            )
          },
        )
        .on('error', reject)
    })
  assert.equal((await request()).status, 200)
  const denied = await request({}, '/private')
  assert.equal(denied.status, 401)
  assert.equal(denied.text, 'Application login required')
  assert.equal((await request({ cookie: 'match_session=match-token' }, '/private')).status, 200)
  assert.equal((await request({ authorization: 'Bearer app-token' }, '/private')).status, 200)
  const result = await request(
    {
      cookie: 'match_session=match-token; csrf=app-csrf',
      authorization: 'Bearer app-token',
      origin: 'https://app.example.com',
      'x-forwarded-user': 'forged',
    },
    '/screen?test=1',
  )
  assert.equal(result.status, 200)
  assert.equal(result.text, 'Preview fixture')
  assert.equal(seen.url, '/screen?test=1')
  assert.equal(seen.headers.cookie, 'match_session=match-token; csrf=app-csrf')
  assert.equal(seen.headers.authorization, 'Bearer app-token')
  assert.equal(seen.headers['x-forwarded-user'], undefined)
  assert.equal(seen.headers.origin, 'https://app.example.com')
  assert.equal(seen.headers['x-forwarded-proto'], 'https')
  assert.equal(seen.headers['x-forwarded-host'], host)
  const login = await request({}, '/login')
  assert.equal(login.status, 302)
  assert.equal(login.headers.location, '/private')
  assert.deepEqual(login.headers['set-cookie'], [
    'match_session=match-token; Domain=example.com; Path=/; Secure; HttpOnly',
    'csrf=app-csrf; Path=/; Secure',
  ])
  assert.equal(
    (await request({ origin: 'https://other.example.com' }, '/restricted-origin')).status,
    403,
  )
  assert.equal(result.headers['cache-control'], 'no-store')
  const upgrade = async (cookie) =>
    new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: gatewayPort,
        headers: { host, connection: 'Upgrade', upgrade: 'test', ...(cookie ? { cookie } : {}) },
      })
      req.on('upgrade', (res, socket) => {
        socket.destroy()
        resolve(res.statusCode)
      })
      req.on('response', (res) => {
        res.resume()
        resolve(res.statusCode)
      })
      req.on('error', reject)
      req.end()
    })
  assert.equal(await upgrade(), 401)
  assert.equal(await upgrade('match_session=match-token'), 101)
  assert.equal(seen.headers.cookie, 'match_session=match-token')
  assert.equal((await request({ host: 'unknown.preview.example.com' })).status, 404)
  assert.equal((await request({ host: '127.0.0.1' }, `/_regent/tls?domain=${host}`)).status, 200)
  assert.equal(
    (await request({ host: '127.0.0.1' }, '/_regent/tls?domain=unregistered.preview.example.com'))
      .status,
    403,
  )
  console.log(
    '  OK app-owned HTTP/WebSocket authentication, cookies, bearer tokens, redirects, origin policy and TLS allowlist',
  )
  // Ownership is rechecked after restart and before stopping, protecting reused PIDs.
  const resumed = new Previews(
    store,
    config,
    (pid) => processInfo,
    (pid) => killed.push(pid),
    () => now,
    () => true,
  )
  assert.equal(resumed.result(resumed.get('one')).ready, true)
  processInfo.start = 'reused'
  assert.equal(resumed.resolve(host), undefined)
  resumed.stop('one')
  assert.deepEqual(killed, [])
  await close(app)
  const renewed = await resumed.reserve('one', directory)
  app.listen(renewed.port, '127.0.0.1')
  await once(app, 'listening')
  processInfo = { cwd: directory, start: 'new-process', group: 42 }
  await resumed.publish('one', 42)
  now += 6 * 60000
  assert.equal(resumed.result(resumed.get('one')).ready, false)
  assert.equal(resumed.resolve(new URL(renewed.url).hostname), undefined)
  resumed.expire()
  assert.deepEqual(killed, [42])
  assert.equal(resumed.get('one'), undefined)
  console.log('  OK persistent previews, PID reuse protection, expiry and owned process cleanup')
  const base = ConfigSchema.parse({
    auth: { mode: 'indie' },
    repos: { path: directory },
    slack: { workspace_team_id: 'T1', allowed_users: ['U1'] },
  })
  const core = new Core({
    store,
    config: base,
    cwd: directory,
    output: { async notice() {}, async status() {}, async delta() {}, async finish() {} },
  })
  const coreHttp = createHttp(core, () => ({}))
  const corePort = await listen(coreHttp)
  const accepted = store.accept(
    {
      adapter: 'slack',
      eventId: 'test',
      key: 'test',
      author: 'U1',
      team: 'T1',
      channel: 'C1',
      text: 'test',
      intent: 'ask',
    },
    directory,
    24,
  )
  store.db.prepare("UPDATE runs SET state='running' WHERE id=?").run(accepted.runId)
  core.active.set('test', {
    run: store.run(accepted.runId),
    token: 'test',
    controller: {},
    operations: new Set(),
    abort: new AbortController(),
    output: Promise.resolve(),
    waiting: false,
    cancelled: false,
  })
  for (const enabled of [false, true]) {
    core.previews = enabled ? previews : undefined
    const response = await fetch(`http://127.0.0.1:${corePort}/tools`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    const payload = await response.json()
    assert.equal(
      payload.result.tools.some((tool) => tool.name === 'regent_preview'),
      enabled,
    )
  }
  core.active.clear()
  await close(coreHttp)
  console.log('  OK preview tool is advertised only when the server configures the gateway')
} finally {
  previews?.close()
  if (gateway?.listening) await close(gateway)
  if (app.listening) await close(app)
  store.close()
  fs.rmSync(directory, { recursive: true, force: true })
}
