import assert from 'node:assert/strict'
import { replyPayloads } from '../src/slack-format.ts'
import { SlackOutput } from '../src/slack.ts'

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

let attempts = 0
const fallback = new SlackOutput(async (_method, args) => {
  if (++attempts === 1) throw Object.assign(new Error('invalid_blocks'), { data: { error: 'invalid_blocks' } })
  assert.equal(args.blocks[0].text.type, 'plain_text')
  assert.equal(args.blocks[0].text.text, text)
  return {}
})
await fallback.notice(c, text)
assert.equal(attempts, 2)
console.log('Slack Markdown payloads, final stream updates and literal fallback passed')
