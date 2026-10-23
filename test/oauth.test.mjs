import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createHash, generateKeyPairSync, randomBytes, sign, randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { ConfigSchema } from '../src/config.ts'
import { Store } from '../src/store.ts'
import { Core } from '../src/core.ts'
import { ExternalMcp } from '../src/mcp.ts'
import { createHttp } from '../src/http.ts'
import { mcpOutput } from '../src/mcp-output.ts'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-oauth-')))
const digest = (value) => createHash('sha256').update(value).digest('base64url')
const random = () => randomBytes(32).toString('base64url')
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const untrusted = generateKeyPairSync('rsa', { modulusLength: 2048 })
const publicKey = {
  ...keys.publicKey.export({ format: 'jwk' }),
  kid: 'fixture',
  use: 'sig',
  alg: 'RS256',
}
let identity = { sub: 'alice', email: 'alice@example.test', name: 'Alice', email_verified: true },
  fault
const upstreamCodes = new Map()
const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)),
  )
const json = (res, value, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}
const jwt = (claims) => {
  const body =
    Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url') +
    '.' +
    Buffer.from(JSON.stringify(claims)).toString('base64url')
  return (
    body +
    '.' +
    sign(
      'RSA-SHA256',
      Buffer.from(body),
      fault === 'signature' ? untrusted.privateKey : keys.privateKey,
    ).toString('base64url')
  )
}
const provider = http.createServer(async (req, res) => {
  const url = new URL(req.url, upstream)
  if (url.pathname === '/.well-known/openid-configuration')
    return json(res, {
      issuer: upstream,
      authorization_endpoint: upstream + '/authorize',
      token_endpoint: upstream + '/token',
      jwks_uri: upstream + '/jwks',
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      code_challenge_methods_supported: ['S256'],
    })
  if (url.pathname === '/jwks') return json(res, { keys: [publicKey] })
  if (url.pathname === '/authorize') {
    const code = random()
    upstreamCodes.set(code, Object.fromEntries(url.searchParams))
    const redirect = new URL(url.searchParams.get('redirect_uri'))
    redirect.searchParams.set('code', code)
    redirect.searchParams.set('state', url.searchParams.get('state'))
    res.writeHead(302, { location: redirect.href })
    res.end()
    return
  }
  if (url.pathname === '/token') {
    let body = ''
    for await (const chunk of req) body += chunk
    const params = new URLSearchParams(body),
      code = upstreamCodes.get(params.get('code'))
    if (
      !code ||
      params.get('client_secret') !== 'fixture-secret' ||
      params.get('client_id') !== 'fixture-client' ||
      params.get('redirect_uri') !== code.redirect_uri ||
      digest(params.get('code_verifier')) !== code.code_challenge
    )
      return json(res, { error: 'invalid_grant' }, 400)
    upstreamCodes.delete(params.get('code'))
    const claims = {
      iss: fault === 'issuer' ? upstream + '/wrong' : upstream,
      aud: fault === 'audience' ? 'wrong-client' : 'fixture-client',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + (fault === 'expired' ? -60 : 600),
      nonce: fault === 'nonce' ? 'wrong-nonce' : code.nonce,
      ...identity,
    }
    return json(res, {
      token_type: 'Bearer',
      access_token: 'upstream-access-not-for-mcp',
      expires_in: 600,
      id_token: jwt(claims),
    })
  }
  res.writeHead(404)
  res.end()
})
const upstream = await listen(provider)
const storeFile = path.join(root, 'oauth.sqlite')
const store = new Store(storeFile)
fs.mkdirSync(path.join(root, '.git'))
fs.writeFileSync(path.join(root, '.env'), 'REGENT_OIDC_TEST_SECRET=must-not-reach-agent\n')
const config = ConfigSchema.parse({
  name: 'Fixture Code',
  auth: { mode: 'indie' },
  repos: { path: root },
  slack: { workspace_team_id: 'T1' },
  mcp: {
    enabled: true,
    principals: [],
    oauth: {
      issuer_url: 'http://127.0.0.1',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      oidc: {
        issuer_url: upstream,
        client_id: 'fixture-client',
        client_secret_env: 'REGENT_OIDC_TEST_SECRET',
        allowed_emails: ['alice@example.test', 'bob@example.test'],
      },
    },
  },
})
const starts = []
const core = new Core({
  store,
  config,
  cwd: root,
  output: mcpOutput(store),
  runner: (options) => {
    starts.push(options)
    options.onEvent({ kind: 'init', sessionId: options.sessionId ?? randomUUID() })
    return {
      done: Promise.resolve({
        state: 'completed',
        text: 'fixture result',
        error: '',
        cost: 0,
        usage: {},
      }),
      cancel() {},
    }
  },
})
let external, handler
const server = http.createServer((req, res) => handler.emit('request', req, res))
const base = await listen(server)
config.mcp.oauth.issuer_url = base
external = new ExternalMcp(core, { REGENT_OIDC_TEST_SECRET: 'fixture-secret' })
handler = createHttp(core, () => ({}), external)
core.toolsUrl = base + '/tools'
const get = (url, cookie) => fetch(url, { redirect: 'manual', headers: cookie ? { cookie } : {} })
const post = (endpoint, body, headers = {}) =>
  fetch(base + endpoint, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(body),
  })
const register = async (callback) => {
  const response = await fetch(base + '/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: '<Fixture Client>',
      token_endpoint_auth_method: 'none',
      redirect_uris: [callback ?? 'https://claude.ai/api/mcp/auth_callback'],
    }),
  })
  return { response, client: await response.json() }
}
const begin = async (client, changes = {}) => {
  const verifier = random()
  const url = new URL(base + '/authorize')
  for (const [key, value] of Object.entries({
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    response_type: 'code',
    code_challenge: digest(verifier),
    code_challenge_method: 'S256',
    scope: 'regent:execute',
    resource: base + '/mcp',
    state: 'client-state',
    ...changes,
  }))
    url.searchParams.set(key, value)
  const response = await get(url)
  return {
    response,
    verifier,
    cookie: response.headers.get('set-cookie')?.split(';')[0],
    upstream: response.headers.get('location'),
  }
}
const login = async (client) => {
  const flow = await begin(client)
  assert.equal(flow.response.status, 302)
  const providerResponse = await get(flow.upstream)
  const callback = providerResponse.headers.get('location')
  const response = await get(callback, flow.cookie)
  return {
    ...flow,
    response,
    callback,
    consentUrl: new URL(response.headers.get('location') ?? '/', base),
  }
}
const approve = async (client, decision = 'allow') => {
  const flow = await login(client)
  assert.equal(flow.response.status, 302)
  const consent = await get(flow.consentUrl, flow.cookie),
    html = await consent.text()
  assert.equal(consent.headers.get('referrer-policy'), 'same-origin')
  const formPolicy = consent.headers
    .get('content-security-policy')
    .split(';')
    .find((value) => value.trim().startsWith('form-action'))
  assert.deepEqual(formPolicy.trim().split(/\s+/), ['form-action', "'self'", 'https://claude.ai'])
  assert.ok(html.includes('&lt;Fixture Client&gt;'))
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1]
  const request = flow.consentUrl.searchParams.get('request')
  const rejected = await post(
    '/oauth/consent',
    { request, csrf, decision },
    { cookie: flow.cookie, origin: 'https://attacker.invalid' },
  )
  assert.equal(rejected.status, 403)
  const opaque = await post(
    '/oauth/consent',
    { request, csrf, decision },
    { cookie: flow.cookie, origin: 'null' },
  )
  assert.equal(opaque.status, 403)
  const response = await post(
    '/oauth/consent',
    { request, csrf, decision },
    { cookie: flow.cookie, origin: base },
  )
  assert.equal(response.status, 302)
  const redirect = new URL(response.headers.get('location'))
  assert.equal(redirect.searchParams.get('state'), 'client-state')
  return { ...flow, code: redirect.searchParams.get('code'), redirect }
}
const exchange = async (client, flow, changes = {}) => {
  const response = await post('/token', {
    grant_type: 'authorization_code',
    client_id: client.client_id,
    code: flow.code,
    code_verifier: flow.verifier,
    redirect_uri: client.redirect_uris[0],
    resource: base + '/mcp',
    ...changes,
  })
  return { response, tokens: await response.json() }
}
const connect = async (token) => {
  const client = new Client({ name: 'oauth-fixture', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  )
  return client
}
let failures = 0
const check = async (name, task) => {
  try {
    await task()
    console.log('  OK ' + name)
  } catch (error) {
    failures++
    console.error('  FAIL ' + name + ': ' + error.stack)
  }
}
try {
  const { client } = await register()
  await check('OAuth metadata, PKCE and registration reject unapproved callbacks', async () => {
    const unauthorized = await fetch(base + '/mcp', { method: 'POST' })
    assert.equal(unauthorized.status, 401)
    assert.ok(unauthorized.headers.get('www-authenticate').includes('resource_metadata='))
    const metadata = await (await get(base + '/.well-known/oauth-authorization-server')).json()
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256'])
    assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ['none'])
    const resource = await (await get(base + '/.well-known/oauth-protected-resource/mcp')).json()
    assert.equal(resource.resource, base + '/mcp')
    assert.equal((await register('https://attacker.invalid/callback')).response.status, 400)
    const other = (await register()).client
    const denied = await begin(client, { resource: base + '/wrong' })
    assert.equal(
      new URL(denied.response.headers.get('location')).searchParams.get('error'),
      'invalid_request',
    )
    const missingPkce = await begin(client, { code_challenge_method: 'plain' })
    assert.equal(
      new URL(missingPkce.response.headers.get('location')).searchParams.get('error'),
      'invalid_request',
    )
    const foreignCode = await approve(client)
    assert.equal((await exchange(other, foreignCode)).response.status, 400)
  })
  await check(
    'verified identity, browser consent, one-use bound codes and root credential isolation',
    async () => {
      const flow = await approve(client)
      assert.equal((await exchange(client, flow, { code_verifier: random() })).response.status, 400)
      assert.equal(
        (await exchange(client, flow, { resource: upstream + '/mcp' })).response.status,
        400,
      )
      const { tokens, response } = await exchange(client, flow)
      assert.equal(response.status, 200)
      assert.equal((await exchange(client, flow)).response.status, 400)
      assert.notEqual(tokens.access_token, 'upstream-access-not-for-mcp')
      const connection = await connect(tokens.access_token)
      try {
        const result = await connection.callTool({
          name: 'regent_start',
          arguments: { request_id: randomUUID(), prompt: 'Read this fixture' },
        })
        assert.ok(!result.isError)
        while (core.active.size) await new Promise((resolve) => setTimeout(resolve, 10))
        assert.equal(starts.at(-1).env.REGENT_OIDC_TEST_SECRET, undefined)
        assert.ok(starts.at(-1).prompt.includes('alice@example.test'))
      } finally {
        await connection.close()
      }
      const dump = JSON.stringify(store.db.prepare('SELECT * FROM oauth_tokens').all())
      assert.ok(!dump.includes(tokens.access_token) && !dump.includes(tokens.refresh_token))
    },
  )
  await check(
    'OIDC rejects forged signature, nonce, audience, expiry, issuer and unverified or disallowed email',
    async () => {
      for (const invalid of ['signature', 'nonce', 'audience', 'expired', 'issuer']) {
        fault = invalid
        const flow = await login(client)
        assert.equal(flow.response.status, 403, invalid)
      }
      fault = undefined
      identity = { ...identity, email_verified: false }
      assert.equal((await login(client)).response.status, 403)
      identity = { ...identity, email_verified: true, email: 'outsider@example.test' }
      assert.equal((await login(client)).response.status, 403)
      identity = { ...identity, email: 'alice@example.test' }
    },
  )
  await check('browser binding and rejected consent never issue MCP credentials', async () => {
    const initial = await begin(client)
    const redirect = await get(initial.upstream)
    const callback = redirect.headers.get('location')
    assert.equal((await get(callback)).status, 403)
    assert.equal((await get(callback, initial.cookie)).status, 302)
    assert.equal((await get(callback, initial.cookie)).status, 403)
    const flow = await approve(client, 'deny')
    assert.equal(flow.redirect.searchParams.get('error'), 'access_denied')
    assert.equal(flow.code, null)
  })
  await check(
    'official MCP client discovers OAuth, registers, signs in and reconnects without a manual bearer',
    async () => {
      const state = {}
      const authProvider = {
        redirectUrl: 'https://claude.ai/api/mcp/auth_callback',
        clientMetadata: {
          client_name: 'SDK Client',
          redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        },
        state: () => 'sdk-state',
        clientInformation: () => state.client,
        saveClientInformation: (value) => {
          state.client = value
        },
        tokens: () => state.tokens,
        saveTokens: (value) => {
          state.tokens = value
        },
        redirectToAuthorization: (value) => {
          state.url = value
        },
        saveCodeVerifier: (value) => {
          state.verifier = value
        },
        codeVerifier: () => state.verifier,
      }
      const initialClient = new Client({ name: 'oauth-discovery-fixture', version: '1' })
      const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), { authProvider })
      await assert.rejects(() => initialClient.connect(transport), UnauthorizedError)
      assert.ok(state.client?.client_id)
      const authorization = await get(state.url)
      const cookie = authorization.headers.get('set-cookie').split(';')[0]
      const upstreamResponse = await get(authorization.headers.get('location'))
      const callback = await get(upstreamResponse.headers.get('location'), cookie)
      const consentUrl = new URL(callback.headers.get('location'), base)
      const html = await (await get(consentUrl, cookie)).text()
      const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1]
      const confirmed = await post(
        '/oauth/consent',
        { request: consentUrl.searchParams.get('request'), csrf, decision: 'allow' },
        { cookie, origin: base },
      )
      const redirect = new URL(confirmed.headers.get('location'))
      assert.equal(redirect.searchParams.get('state'), 'sdk-state')
      await transport.finishAuth(redirect.searchParams.get('code'))
      await initialClient.close()
      assert.ok(state.tokens?.access_token)
      const connection = new Client({ name: 'oauth-reconnect-fixture', version: '1' })
      try {
        await connection.connect(
          new StreamableHTTPClientTransport(new URL(base + '/mcp'), { authProvider }),
        )
        assert.equal((await connection.listTools()).tools.length, 6)
      } finally {
        await connection.close()
      }
    },
  )
  await check(
    'identity ownership, refresh rotation, replay revocation and expiry are enforced',
    async () => {
      const alice = (await exchange(client, await approve(client))).tokens
      const aliceClient = await connect(alice.access_token)
      const created = await aliceClient.callTool({
        name: 'regent_start',
        arguments: { request_id: randomUUID(), prompt: 'Alice work' },
      })
      const run = created.structuredContent ?? JSON.parse(created.content[0].text)
      await aliceClient.close()
      identity = { sub: 'bob', email: 'bob@example.test', name: 'Bob', email_verified: true }
      const bob = (await exchange(client, await approve(client))).tokens
      const bobClient = await connect(bob.access_token)
      try {
        const rejected = await bobClient.callTool({
          name: 'regent_get_run',
          arguments: { run_id: run.run_id },
        })
        assert.equal(rejected.isError, true)
      } finally {
        await bobClient.close()
      }
      const refresh = await post('/token', {
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: bob.refresh_token,
        resource: base + '/mcp',
      })
      assert.equal(refresh.status, 200)
      const renewed = await refresh.json()
      assert.notEqual(renewed.refresh_token, bob.refresh_token)
      const replay = await post('/token', {
        grant_type: 'refresh_token',
        client_id: client.client_id,
        refresh_token: bob.refresh_token,
        resource: base + '/mcp',
      })
      assert.equal(replay.status, 400)
      await assert.rejects(() => external.oauth.verifyAccessToken(renewed.access_token))
      store.db.prepare("UPDATE oauth_tokens SET expires_at=0 WHERE kind='access'").run()
      await assert.rejects(() => external.oauth.verifyAccessToken(alice.access_token))
      identity = { sub: 'alice', email: 'alice@example.test', name: 'Alice', email_verified: true }
    },
  )
  await check(
    'refresh tokens persist across restart, obey current access policy and revoke as a family',
    async () => {
      const tokens = (await exchange(client, await approve(client))).tokens
      const reopened = new Store(storeFile)
      const { OAuthStore } = await import('../src/oauth-store.ts')
      const persisted = new OAuthStore(reopened, (user) =>
        config.mcp.oauth.oidc.allowed_emails.includes(user.email),
      )
      const renewed = persisted.refresh(client.client_id, tokens.refresh_token, base + '/mcp')
      assert.equal(persisted.verify(renewed.access_token, base + '/mcp').clientId, client.client_id)
      reopened.close()
      const revoked = await post('/revoke', {
        client_id: client.client_id,
        token: renewed.refresh_token,
      })
      assert.equal(revoked.status, 200)
      await assert.rejects(() => external.oauth.verifyAccessToken(renewed.access_token))
      const granted = (await exchange(client, await approve(client))).tokens
      config.mcp.oauth.oidc.allowed_emails = ['bob@example.test']
      await assert.rejects(() => external.oauth.verifyAccessToken(granted.access_token))
    },
  )
} finally {
  await core.close()
  await new Promise((resolve) => server.close(resolve))
  await new Promise((resolve) => provider.close(resolve))
  store.close()
  fs.rmSync(root, { recursive: true, force: true })
}
if (failures) process.exitCode = 1
