/** Markdown → bloques: vallas, toggle con hijos, callout, quotes fusionados. */
import assert from 'node:assert'
import { mdToBlocks } from '../src/md-blocks.ts'

let failed = 0
const check = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`) } catch (err) { failed++; console.error(`  ✗ ${name}: ${err.message}`) } }
const text = b => Object.values(b).find(v => v && typeof v === 'object' && v.rich_text)?.rich_text.map(r => r.text.content).join('')
console.log('md-blocks:')

check('valla ``` → bloque code con lenguaje normalizado', () => {
  const [b] = mdToBlocks('```json\n{"a":1}\n```')
  assert.equal(b.type, 'code'); assert.equal(b.code.language, 'json'); assert.equal(text(b), '{"a":1}')
})

check('quotes consecutivos → UN solo quote (no uno por línea)', () => {
  const bs = mdToBlocks('> línea 1\n> línea 2\n> línea 3')
  assert.equal(bs.length, 1); assert.equal(bs[0].type, 'quote'); assert.equal(text(bs[0]), 'línea 1\nlínea 2\nlínea 3')
})

check('toggle <details> con hijos, incluido código adentro (el caso del trace)', () => {
  const md = '<details><summary>Hilo de origen (Slack)</summary>\n**[app bot]:** Message\n```json\n{"file":"x.php:17"}\n```\n</details>'
  const bs = mdToBlocks(md)
  assert.equal(bs.length, 1); assert.equal(bs[0].type, 'toggle'); assert.equal(text(bs[0]), 'Hilo de origen (Slack)')
  const kids = bs[0].toggle.children
  assert.deepEqual(kids.map(k => k.type), ['paragraph', 'code'])
  assert.equal(text(kids[1]), '{"file":"x.php:17"}')
})

check('callout > [!QUESTION] con varias líneas y su ícono', () => {
  const bs = mdToBlocks('> [!QUESTION] Preguntas abiertas\n> - [rápida] ¿Sí o no?\n> - [con contexto] ¿Qué relación?')
  assert.equal(bs.length, 1); assert.equal(bs[0].type, 'callout')
  assert.equal(bs[0].callout.icon.emoji, '❓')
  assert.match(text(bs[0]), /\[rápida\] ¿Sí o no\?/); assert.match(text(bs[0]), /\[con contexto\]/)
})

check('callout y quote no se mezclan', () => {
  const bs = mdToBlocks('> [!WARNING] ojo\n> cita aparte')
  // "cita aparte" pertenece al callout (continuación); un quote nuevo necesita línea en blanco o otro marcador
  assert.equal(bs.length, 1); assert.equal(bs[0].type, 'callout'); assert.equal(bs[0].callout.icon.emoji, '⚠️')
})

check('anidamiento acotado: un toggle dentro de un toggle dentro de otro no explota', () => {
  const md = '<details><summary>a</summary>\n<details><summary>b</summary>\n<details><summary>c</summary>\nx\n</details>\n</details>\n</details>'
  const bs = mdToBlocks(md)
  assert.equal(bs[0].type, 'toggle')
  const b = bs[0].toggle.children[0]; assert.equal(b.type, 'toggle')
  const c = b.toggle.children[0]; assert.equal(c.type, 'toggle'); assert.equal(c.toggle.children, undefined)
})

check('lo básico sigue igual: títulos, listas, to-do, divider, párrafo', () => {
  const bs = mdToBlocks('## T\n- a\n1. b\n- [x] c\n---\ntexto')
  assert.deepEqual(bs.map(b => b.type), ['heading_2', 'bulleted_list_item', 'numbered_list_item', 'to_do', 'divider', 'paragraph'])
})

if (failed) { console.error(`\n${failed} fallaron`); process.exit(1) }
