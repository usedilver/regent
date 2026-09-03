/** El espejo a Slack conserva negrita/código/links del comentario de Notion en mrkdwn. */
import assert from 'node:assert'
import { richToMrkdwn } from '../src/notion-rich.ts'

let failed = 0
const check = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`) } catch (err) { failed++; console.error(`  ✗ ${name}: ${err.message}`) } }
const t = (plain_text, annotations = {}, href = null) => ({ plain_text, annotations, href })
console.log('notion-rich:')

check('negrita, código y link → *x*, `x`, <url|x>', () => {
  const out = richToMrkdwn([t('Ya tengo '), t('todo', { bold: true }), t(' en '), t('skill()', { code: true }), t(' ver '), t('el card', {}, 'https://n.so/x')])
  assert.equal(out, 'Ya tengo *todo* en `skill()` ver <https://n.so/x|el card>')
})

check('los marcadores no envuelven espacios de borde; & < > se escapan fuera del código', () => {
  assert.equal(richToMrkdwn([t(' a & b ', { bold: true })]), ' *a &amp; b* ')
  assert.equal(richToMrkdwn([t('x < y', { code: true })]), '`x < y`')
})

check('texto plano y saltos de línea pasan intactos', () => {
  assert.equal(richToMrkdwn([t('línea 1\n- [rápida] ¿sí?\n')]), 'línea 1\n- [rápida] ¿sí?\n')
})

if (failed) { console.error(`\n${failed} fallaron`); process.exit(1) }
