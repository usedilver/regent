/**
 * Test del handler del webhook (Fase 6.1): fabrica eventos firmados válidos e
 * inválidos con signWebhookPayload() del SDK, sin depender de Notion.
 * Ejecutar: npm test
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { signWebhookPayload } from '@notionhq/client'
import assert from 'node:assert'
import { makeBridgeFixture } from './fixture.mjs'

const BRIDGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PORT = 8799
const TOKEN = 'test_verification_token_123'
const URL_BASE = `http://127.0.0.1:${PORT}`

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'))
const fixture = makeBridgeFixture() // config de instancia + carpeta de repos

const server = spawn('node', [path.join(BRIDGE_DIR, 'src', 'server.ts')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    NOTION_VERIFICATION_TOKEN: TOKEN,
    NOTION_TOKEN: 'ntn_fake_token_for_tests',
    DATABASE_ID: '00000000000000000000000000000db1',
    DATA_SOURCE_ID: '00000000-0000-4000-8000-0000000000d5',
    BRIDGE_CONFIG_DIR: fixture.configDir,
    REPO_PATH: fixture.reposRoot,
    LAUNCHER: '/usr/bin/true',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverOut = ''
server.stdout.on('data', d => { serverOut += d })
server.stderr.on('data', d => { serverOut += d })

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${URL_BASE}/healthz`)
      if (res.ok) return
    } catch { /* aún no arriba */ }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('server no arrancó:\n' + serverOut)
}

function makeEvent(overrides = {}) {
  return JSON.stringify({
    id: `evt-${Math.random().toString(36).slice(2)}`,
    timestamp: '2026-08-08T12:00:00.000Z',
    type: 'page.properties_updated',
    attempt_number: 1,
    entity: { id: '00000000-0000-4000-8000-000000000a93', type: 'page' },
    authors: [{ id: '00000000-0000-4000-8000-0000000000c5', type: 'person' }],
    data: {
      parent: { id: '00000000-0000-4000-8000-0000000000d5', type: 'data_source' },
      updated_properties: ['SklHXA'],
    },
    ...overrides,
  })
}

async function post(body, signature) {
  const headers = { 'content-type': 'application/json' }
  if (signature) headers['x-notion-signature'] = signature
  return fetch(`${URL_BASE}/notion-webhook`, { method: 'POST', headers, body })
}

let failed = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`  ✗ ${name}: ${err.message}`)
  }
}

try {
  await waitForServer()
  console.log('server arriba, corriendo tests:')

  await check('healthz responde 200', async () => {
    const res = await fetch(`${URL_BASE}/healthz`)
    assert.equal(res.status, 200)
  })

  await check('evento con firma válida → 200', async () => {
    const body = makeEvent()
    const sig = await signWebhookPayload({ body, verificationToken: TOKEN })
    const res = await post(body, sig)
    assert.equal(res.status, 200)
  })

  await check('evento con firma inválida → 401', async () => {
    const body = makeEvent()
    const sig = await signWebhookPayload({ body, verificationToken: 'token_equivocado' })
    const res = await post(body, sig)
    assert.equal(res.status, 401)
  })

  await check('evento sin firma → 401', async () => {
    const res = await post(makeEvent(), null)
    assert.equal(res.status, 401)
  })

  await check('body re-serializado con espacios distintos → 401 (firma sobre bytes exactos)', async () => {
    const body = makeEvent()
    const sig = await signWebhookPayload({ body, verificationToken: TOKEN })
    const tampered = JSON.stringify(JSON.parse(body), null, 2)
    const res = await post(tampered, sig)
    assert.equal(res.status, 401)
  })

  await check('ruta desconocida → 404', async () => {
    const res = await fetch(`${URL_BASE}/otra-ruta`, { method: 'POST', body: '{}' })
    assert.equal(res.status, 404)
  })

  await check('JSON inválido → 400', async () => {
    const res = await post('esto no es json', null)
    assert.equal(res.status, 400)
  })
} finally {
  server.kill()
  fs.rmSync(tmpHome, { recursive: true, force: true })
  fixture.cleanup()
}

if (failed > 0) {
  console.error(`\n${failed} test(s) fallaron`)
  process.exit(1)
}
console.log('\ntodos los tests pasaron ✓')
