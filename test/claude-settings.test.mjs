/** El aviso de bypass se pre-acepta una vez y sin pisar la config del operador. */
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureBypassAccepted } from '../src/claude-settings.ts'

let failed = 0
const check = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`) } catch (err) { failed++; console.error(`  ✗ ${name}: ${err.message}`) } }
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-')), '.claude', 'settings.json')
console.log('claude-settings:')

check('sin settings.json: lo crea con el flag', () => {
  const p = tmp()
  assert.equal(ensureBypassAccepted(p), 'seeded')
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).skipDangerousModePermissionPrompt, true)
})

check('conserva el resto de la config y es idempotente', () => {
  const p = tmp(); fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify({ theme: 'light', permissions: { allow: ['Bash(ls:*)'] } }))
  assert.equal(ensureBypassAccepted(p), 'seeded')
  assert.equal(ensureBypassAccepted(p), 'already')
  const s = JSON.parse(fs.readFileSync(p, 'utf8'))
  assert.equal(s.theme, 'light'); assert.deepEqual(s.permissions, { allow: ['Bash(ls:*)'] }); assert.equal(s.skipDangerousModePermissionPrompt, true)
})

check('un settings.json corrupto no se pisa', () => {
  const p = tmp(); fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, '{oops')
  assert.equal(ensureBypassAccepted(p), 'unreadable')
  assert.equal(fs.readFileSync(p, 'utf8'), '{oops')
})

if (failed) { console.error(`\n${failed} fallaron`); process.exit(1) }
