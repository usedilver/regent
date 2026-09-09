import assert from 'node:assert/strict'
import { normalizeEmailLinks, replyPayloads } from '../src/slack-format.ts'
import { SlackOutput } from '../src/slack.ts'

const address = 'person+test@example.com'
const link = `[${address}](mailto:${address})`
assert.equal(normalizeEmailLinks(`Email: mailto:${address}.`), `Email: ${link}.`)
assert.equal(normalizeEmailLinks(`<mailto:${address}>`), link)
assert.equal(normalizeEmailLinks(`[mailto:${address}](mailto:${address})`), link)
assert.equal(normalizeEmailLinks(link), link)
assert.equal(normalizeEmailLinks(`- **Email:** ${address} *(cuenta interna)*`), `- **Email:** ${link} *(cuenta interna)*`)
assert.equal(normalizeEmailLinks(`<${address}>`), link)
assert.equal(normalizeEmailLinks(`https://example.com/${address}`), `https://example.com/${address}`)
assert.equal(normalizeEmailLinks(`https://${address}/path`), `https://${address}/path`)
assert.equal(normalizeEmailLinks(`\`${address}\``), `\`${address}\``)
assert.equal(normalizeEmailLinks(normalizeEmailLinks(`Email: ${address}`)), `Email: ${link}`)
assert.equal(replyPayloads(`- **Email:** ${address}`)[0].blocks[0].text, `- **Email:** ${link}`)
assert.equal(normalizeEmailLinks(`[Contactar](mailto:${address}?subject=Hola)`), `[Contactar](mailto:${address}?subject=Hola)`)
for (const code of ['`mailto:person@example.com`', '``mailto:person@example.com``',
  '```text\nmailto:person@example.com\n```', '~~~\nmailto:person@example.com\n~~~',
  '```\nmailto:person@example.com', '    mailto:person@example.com', '`mailto:person@example.com']) {
  assert.equal(normalizeEmailLinks(code), code)
}
assert.equal(replyPayloads(`Email: mailto:${address}`)[0].blocks[0].text, `Email: ${link}`)

const text = '### Resultado\n**Cliente:** ejemplo\n- **Crear y editar**\n[Repo](https://example.com/a_b)\n```js\nconst value = "**literal**"\n```\n| A | B |\n|---|---|\n| 1 | 2 |'
assert.deepEqual(replyPayloads(text), [{ text, blocks: [{ type: 'markdown', text }] }])
const long = ('Texto de prueba '.repeat(200) + '😀').repeat(7)
const pages = replyPayloads(long)
assert.equal(pages.map(p => p.text).join(''), long)
assert.ok(pages.every(p => p.text.length <= 2800 && p.blocks[0].text.type === 'plain_text'))

const calls = []
const c = { key: 'test', channel: 'C1', thread: '1', author: 'U1', team: 'T1' }
const output = new SlackOutput(async (method, args) => { calls.push({ method, args }); return { ts: '2' } }, 5)
await output.finish(c, { id: 'no-stream' }, text)
assert.equal(calls[0].args.blocks[0].text, text)
await output.delta(c, { id: 'stream', author: 'U1' }, 'Progreso\n')
await new Promise(resolve => setTimeout(resolve, 25))
await output.finish(c, { id: 'stream' }, text)
assert.equal(calls.find(c => c.method === 'chat.update').args.blocks[0].text, text)
await output.finish(c, { id: 'email' }, `mailto:${address}`)
assert.equal(calls.at(-1).args.blocks[0].text, link)

let attempts = 0
const fallback = new SlackOutput(async (_method, args) => {
  if (++attempts === 1) throw Object.assign(new Error('invalid_blocks'), { data: { error: 'invalid_blocks' } })
  assert.equal(args.blocks[0].text.type, 'plain_text')
  assert.equal(args.blocks[0].text.text, text)
  return {}
})
await fallback.notice(c, text)
assert.equal(attempts, 2)
// finish idempotente: un fallo a mitad de una respuesta multipagina no duplica
// paginas al reintentar (mismas paginas ya enviadas se actualizan, no se reponen).
const posted = []
let failOnce = true
const retry = new SlackOutput(async (method, args) => {
  if (method === 'chat.postMessage') {
    if (failOnce && posted.length === 2) { failOnce = false; throw new Error('network') }
    posted.push(args.blocks[0].text.text)
    return { ts: `ts-${posted.length}` }
  }
  if (method === 'chat.update') return { ts: args.ts }
  return { ts: 'x' }
})
const big = ('Bloque de prueba '.repeat(200)).repeat(7)
const bigPages = replyPayloads(big).map(p => p.blocks[0].text.text)
assert.ok(bigPages.length >= 4)
await retry.finish(c, { id: 'retry' }, big).catch(() => {})
await retry.finish(c, { id: 'retry' }, big)
assert.deepEqual(posted, bigPages)

console.log('Slack Markdown payloads, final stream updates and literal fallback passed')
