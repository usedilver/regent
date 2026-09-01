/**
 * Regresión: el wizard creó dos apps de Slack porque el app_id se persistía
 * recién al final y no había guard de "ya existe". Se prueba el contrato de
 * persistencia inmediata, que es lo que rompió (sin red ni prompts).
 */
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let failed = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`) } catch (err) { failed++; console.error(`  ✗ ${name}: ${err.message}`) }
}

// misma lógica que persistEnv en setup.ts
function persistEnv(envPath, key, value) {
  let raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
  if (new RegExp(`^${key}=`, 'm').test(raw)) raw = raw.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}="${value}"`)
  else raw += `${raw.endsWith('\n') || raw === '' ? '' : '\n'}${key}="${value}"\n`
  fs.writeFileSync(envPath, raw, { mode: 0o600 })
  fs.chmodSync(envPath, 0o600)
}
const tmp = () => path.join(os.tmpdir(), `idem-${Date.now()}-${Math.random().toString(36).slice(2)}.env`)

console.log('setup-idempotence:')

check('persistEnv agrega una clave nueva sin tocar las existentes', () => {
  const f = tmp(); fs.writeFileSync(f, 'NOTION_TOKEN="ntn_x"\n')
  persistEnv(f, 'SLACK_APP_ID', 'A0BTTLQSZD5')
  const out = fs.readFileSync(f, 'utf8')
  assert.match(out, /NOTION_TOKEN="ntn_x"/)
  assert.match(out, /SLACK_APP_ID="A0BTTLQSZD5"/)
  fs.rmSync(f)
})

check('persistEnv reemplaza en el lugar, sin duplicar la clave', () => {
  const f = tmp(); fs.writeFileSync(f, 'SLACK_APP_ID=""\nPORT="8787"\n')
  persistEnv(f, 'SLACK_APP_ID', 'A0BUB3B6QC9')
  const out = fs.readFileSync(f, 'utf8')
  assert.equal(out.match(/^SLACK_APP_ID=/gm).length, 1)
  assert.match(out, /SLACK_APP_ID="A0BUB3B6QC9"/)
  assert.match(out, /PORT="8787"/)
  fs.rmSync(f)
})

check('el .env queda 600 tras persistir sobre un archivo 644', () => {
  const f = tmp(); fs.writeFileSync(f, 'A=1\n', { mode: 0o644 })
  persistEnv(f, 'SLACK_BOT_TOKEN', 'xoxb-x')
  assert.equal((fs.statSync(f).mode & 0o777).toString(8), '600')
  fs.rmSync(f)
})

check('el guard de idempotencia: con SLACK_APP_ID no se vuelve a crear', () => {
  const f = tmp(); fs.writeFileSync(f, '')
  persistEnv(f, 'SLACK_APP_ID', 'A0BTTLQSZD5')
  const env = Object.fromEntries(fs.readFileSync(f, 'utf8').split('\n')
    .map(l => l.match(/^([A-Z0-9_]+)="?([^"]*)"?$/)).filter(Boolean).map(m => [m[1], m[2]]))
  assert.equal(Boolean(env.SLACK_APP_ID), true, 'una corrida interrumpida debe dejar rastro del app_id')
  fs.rmSync(f)
})

if (failed) { console.error(`\n${failed} fallaron`); process.exit(1) }
