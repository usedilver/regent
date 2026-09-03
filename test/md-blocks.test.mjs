/** Markdown → bloques: vallas, toggle con hijos, callout, quotes fusionados. */
import assert from 'node:assert'
import { mdToBlocks, inline } from '../src/md-blocks.ts'

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

check('inline: **negrita**, `código`, *cursiva* y [link](url) → anotaciones, sin asteriscos literales', () => {
  const [b] = mdToBlocks('**Contexto**: falla en `Resource.php` con *urgencia* — ver [Sentry](https://sentry.io/x)')
  const rt = b.paragraph.rich_text
  assert.deepEqual(rt.map(r => r.text.content), ['Contexto', ': falla en ', 'Resource.php', ' con ', 'urgencia', ' — ver ', 'Sentry'])
  assert.equal(rt[0].annotations.bold, true); assert.equal(rt[2].annotations.code, true); assert.equal(rt[4].annotations.italic, true)
  assert.equal(rt[6].text.link.url, 'https://sentry.io/x'); assert.equal(rt[1].annotations, undefined)
})

check('inline anida (negrita con código) y aplica al título del toggle y a sus hijos (el caso **[app bot]:**)', () => {
  const [t] = mdToBlocks('<details><summary>Hilo **de origen**</summary>\n**[app bot]:** Message\n</details>')
  assert.deepEqual(t.toggle.rich_text.map(r => [r.text.content, r.annotations?.bold ?? false]), [['Hilo ', false], ['de origen', true]])
  const p = t.toggle.children[0].paragraph.rich_text
  assert.equal(p[0].text.content, '[app bot]:'); assert.equal(p[0].annotations.bold, true); assert.equal(p[1].text.content, ' Message')
  const [b] = mdToBlocks('**negrita con `código`**')
  assert.deepEqual(b.paragraph.rich_text.map(r => r.annotations), [{ bold: true }, { bold: true, code: true }])
})

check('inline no toca snake_case, un * suelto ni el interior de una valla', () => {
  const bs = mdToBlocks('tabla match_user_talently_certifications con 2 * 3\n```sql\nSELECT * FROM t WHERE a = **x**\n```')
  assert.equal(bs[0].paragraph.rich_text.length, 1); assert.equal(bs[0].paragraph.rich_text[0].annotations, undefined)
  assert.equal(text(bs[1]), 'SELECT * FROM t WHERE a = **x**')
})

check('inline: vacío sigue siendo un rich_text válido; lo largo se trocea a 2000 conservando la anotación', () => {
  assert.deepEqual(inline(''), [{ type: 'text', text: { content: '' } }])
  const long = inline('**' + 'a'.repeat(4100) + '**')
  assert.equal(long.length, 3); assert.ok(long.every(r => r.annotations.bold && r.text.content.length <= 2000))
})

check('valla indentada bajo una viñeta → bloque code (des-indentado), no párrafo con backticks', () => {
  const md = "- `Feature.php:20` — cambiar el eager load:\n\n  ```php\n  $this->load([\n      'skill' => fn ($q) => $q->withTrashed(),\n  ]);\n  ```\n  `MatchUser` también usa SoftDeletes."
  const bs = mdToBlocks(md)
  assert.deepEqual(bs.map(b => b.type), ['bulleted_list_item', 'code', 'paragraph'])
  assert.equal(bs[1].code.language, 'php')
  assert.equal(text(bs[1]), "$this->load([\n    'skill' => fn ($q) => $q->withTrashed(),\n]);")
  assert.equal(bs[2].paragraph.rich_text[0].text.content, 'MatchUser'); assert.equal(bs[2].paragraph.rich_text[0].annotations.code, true)
})

check('toggle indentado también se reconoce', () => {
  const bs = mdToBlocks('- item\n  <details><summary>traza</summary>\n  ```\n  boom\n  ```\n  </details>')
  assert.deepEqual(bs.map(b => b.type), ['bulleted_list_item', 'toggle'])
  assert.equal(bs[1].toggle.children[0].type, 'code'); assert.equal(text(bs[1].toggle.children[0]), 'boom')
})

if (failed) { console.error(`\n${failed} fallaron`); process.exit(1) }
