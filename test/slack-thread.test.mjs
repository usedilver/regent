/** El error viaja en attachments (Sentry, Laravel Log) o blocks, no en `text`. Forma real del hilo. */
import assert from 'node:assert'
import { messageBody, appLabel, threadToMarkdown, normalizeFences } from '../src/slack-thread.ts'

let failed = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`) } catch (err) { failed++; console.error(`  ✗ ${name}: ${err.message}`) }
}
console.log('slack-thread:')

const laravelLog = {
  bot_id: 'B1', subtype: 'bot_message', text: '',
  attachments: [{ color: 'danger', title: 'Message', text: 'Attempt to read property "name" on null', fallback: 'Attempt to read property "name" on null',
    fields: [{ title: 'Level', value: 'ERROR' }, { title: 'Context', value: '```{\n  "file": "/var/www/api/app/Services/Match/Http/Resource/MatchUserTalentlyCertificateResource.php:17"\n}```' }] }],
}

check('bot_message con attachment: título, texto y campos entran (el caso Laravel Log)', () => {
  const body = messageBody(laravelLog)
  assert.match(body, /Attempt to read property "name" on null/)
  assert.match(body, /Level: ERROR/)
  assert.match(body, /MatchUserTalentlyCertificateResource\.php:17/)
})

check('mensaje sin nada útil → vacío (se descarta del transcript)', () => {
  assert.equal(messageBody({ text: '', attachments: [], blocks: [] }), '')
})

check('blocks: section y rich_text', () => {
  const body = messageBody({ blocks: [
    { type: 'section', text: { text: 'Deploy failed' } },
    { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'step: build' }] }] },
  ] })
  assert.match(body, /Deploy failed/); assert.match(body, /step: build/)
})

check('fallback solo cuando no hay text; text normal se conserva', () => {
  assert.equal(messageBody({ text: 'hola', attachments: [{ fallback: 'fb' }] }), 'hola\nfb')
  assert.equal(messageBody({ attachments: [{ text: 't', fallback: 'fb' }] }), 't')
})

check('appLabel: bot_profile > username > bot', () => {
  assert.equal(appLabel({ bot_profile: { name: 'Sentry' } }), '[app Sentry]')
  assert.equal(appLabel({ username: 'Demo App' }), '[app Demo App]')
  assert.equal(appLabel({}), '[app bot]')
})

check('threadToMarkdown: plegado, autores en negrita, vallas intactas', () => {
  const t = '[app bot]: Message\nLevel: ERROR\nContext:\n```\n{"file": "@x.php"}\n```\n@Dilver: @Talently ayudame'
  const md = threadToMarkdown(t)
  assert.match(md, /^<details><summary>Hilo de origen \(Slack\)<\/summary>\n/)
  assert.match(md, /\*\*\[app bot\]:\*\* Message/)
  assert.match(md, /\*\*@Dilver:\*\* @Talently ayudame/)
  assert.match(md, /\{"file": "@x.php"\}/, 'dentro de la valla no se toca')
  assert.doesNotMatch(md, /\*\*@x\.php/)
  assert.match(md, /<\/details>$/)
})

check('normalizeFences: la valla inline de un campo queda en líneas propias', () => {
  assert.equal(normalizeFences('```{\n  "file": "x.php:17"\n}```'), '```\n{\n  "file": "x.php:17"\n}\n```')
  const body = messageBody({ attachments: [{ fields: [{ title: 'Exception', value: '```{\n"a":1\n}```' }] }] })
  assert.equal(body, 'Exception:\n```\n{\n"a":1\n}\n```')
})

check('de punta a punta: attachment con valla inline → toggle con bloque code en Notion', async () => {
  const { mdToBlocks } = await import('../src/md-blocks.ts')
  const body = messageBody({ bot_id: 'B', attachments: [{ title: 'Message', text: 'boom', fields: [{ title: 'Exception', value: '```{\n"file":"x.php:17"\n}```' }] }] })
  const [toggle] = mdToBlocks(threadToMarkdown(`[app bot]: ${body}`))
  const types = toggle.toggle.children.map(c => c.type)
  assert.ok(types.includes('code'), `sin bloque code: ${types}`)
})

if (failed) { console.error(`\n${failed} fallaron`); process.exit(1) }
