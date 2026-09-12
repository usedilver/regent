/** El error viaja en attachments (Sentry, Laravel Log) o blocks, no en `text`. Forma real del hilo. */
import assert from 'node:assert'
import { messageBody, appLabel, threadToMarkdown, normalizeFences } from '../src/slack-thread.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import { conversationRoute } from '../src/slack.ts'
import { isolationFor } from '../src/repository.ts'

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

check('DM and normal channels isolate roots, follow-ups, history and worktrees across restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'regent-dm-routing-'))
  const file = path.join(root, 'state.sqlite')
  let store = new Store(file)
  try {
    const accept = (event, repo = '/default') => {
      const route = conversationRoute(store, event)
      const accepted = store.accept({ adapter: 'slack', key: route.key, channel: event.channel,
        eventId: `${event.channel}:${event.ts}`, author: 'U1', team: 'T1', thread: route.thread,
        text: 'hello', history: { channel: event.channel, thread: route.historyThread, latest: event.ts } }, repo, 24)
      return { ...route, ...accepted }
    }
    // Old DM state cannot hijack either new root or replies in an existing thread.
    store.accept({ adapter: 'slack', key: 'slack:D1', channel: 'D1', eventId: 'legacy', author: 'U1', text: 'old' }, '/old-app', 24)
    store.session('slack:D1', 'legacy-session')
    for (const channel of ['D1', 'C1', 'G1']) {
      const first = accept({ channel, ts: '101' }, '/first-app')
      store.session(first.key, 'first-session')
      const second = accept({ channel, ts: '102' })
      assert.notEqual(first.key, second.key)
      assert.equal(first.thread, '101')
      assert.equal(second.historyThread, '102')
      assert.equal(store.conversation(second.key).cwd, '/default')
      assert.equal(store.conversation(second.key).session_id, null)
      assert.notEqual(isolationFor(root, first.key).dir, isolationFor(root, second.key).dir)
      const followup = accept({ channel, ts: '103', thread_ts: '101' })
      assert.equal(followup.key, first.key)
      assert.equal(followup.historyThread, '101')
      assert.equal(store.conversation(followup.key).cwd, '/first-app')
      assert.equal(store.conversation(followup.key).session_id, 'first-session')
      const source = JSON.parse(store.db.prepare('SELECT source FROM run_history WHERE run_id=?').get(second.runId).source)
      assert.equal(source.thread, '102')
      // The stop event resolves exactly the same thread, never its sibling.
      assert.equal(conversationRoute(store, { channel, ts: '104', thread_ts: '101' }).key, first.key)
    }
    store.close(); store = new Store(file)
    const restored = conversationRoute(store, { channel: 'D1', ts: '105', thread_ts: '101' })
    assert.equal(store.conversation(restored.key).session_id, 'first-session')
    assert.equal(store.conversation('slack:D1').session_id, 'legacy-session')
    assert.equal(conversationRoute(store, { channel: 'D1', ts: '106' }).key, 'slack:D1:106')
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }) }
})

if (failed) { console.error(`\n${failed} fallaron`); process.exit(1) }
