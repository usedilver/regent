/** Tests de slack-admin: branding del manifest y deep links (sin red). */
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brandManifest, installUrl, appTokenUrl } from '../src/slack-admin.ts'

let failed = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`) } catch (err) { failed++; console.error(`  ✗ ${name}: ${err.message}`) }
}

console.log('slack-admin:')

check('el manifest del repo se rebrandea con el nombre de la instancia', () => {
  const m = brandManifest(path.join(process.cwd(), 'slack-manifest.json'), 'Talently')
  assert.equal(m.display_information.name, 'Talently')
  assert.equal(m.features.bot_user.display_name, 'Talently')
})

check('conserva scopes y socket mode del manifest original', () => {
  const orig = JSON.parse(fs.readFileSync('slack-manifest.json', 'utf8'))
  const m = brandManifest(path.join(process.cwd(), 'slack-manifest.json'), 'X')
  assert.deepEqual(m.oauth_config.scopes.bot, orig.oauth_config.scopes.bot)
  assert.equal(m.settings.socket_mode_enabled, true)
})

check('respeta los topes de longitud de Slack (35 / 80)', () => {
  const f = path.join(os.tmpdir(), 'm.json')
  fs.writeFileSync(f, JSON.stringify({ display_information: { name: 'x' }, features: { bot_user: { display_name: 'x' } } }))
  const m = brandManifest(f, 'N'.repeat(120))
  assert.equal(m.display_information.name.length, 35)
  assert.equal(m.features.bot_user.display_name.length, 80)
  fs.rmSync(f)
})

check('deep links apuntan a install y a los app-level tokens', () => {
  assert.equal(installUrl('A123'), 'https://api.slack.com/apps/A123/install-on-team')
  assert.match(appTokenUrl('A123'), /A123\/general#app_level_tokens$/)
})

if (failed) { console.error(`\n${failed} fallaron`); process.exit(1) }
