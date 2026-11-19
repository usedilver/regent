import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SlackOutput, answeredBlocks } from '../src/adapters/slack/output.ts'

const blocks = [
  { type: 'section', text: { type: 'plain_text', text: 'Que hago?' } },
  { type: 'section', text: { type: 'plain_text', text: '1. A\n2. B' } },
  { type: 'actions', elements: [{ type: 'button', action_id: 'regent_question_0' }] },
]

const message = { channel: 'C1', ts: '200.1', thread: '100.1', text: 'Que hago?', blocks }

function output() {
  const calls = []
  const slack = new SlackOutput(async (method, args) => {
    calls.push({ method, args })
    return { ok: true }
  })
  return { slack, calls }
}

test('an answered question loses its buttons and says who chose what', () => {
  const answered = answeredBlocks(blocks, 'U9', 1)
  assert.equal(
    answered.some((block) => block.type === 'actions'),
    false,
  )
  assert.deepEqual(answered.slice(0, 2), blocks.slice(0, 2))
  assert.equal(answered.at(-1).elements[0].text, 'Respondido por <@U9>: Opcion 2')
})

test('the answer edits the question in place instead of posting to the channel', async () => {
  const { slack, calls } = output()
  await slack.answered(message, 'U9', 0)
  assert.deepEqual(
    calls.map((call) => call.method),
    ['chat.update'],
  )
  assert.equal(calls[0].args.channel, 'C1')
  assert.equal(calls[0].args.ts, '200.1')
})

test('a private note stays in the question thread', async () => {
  const { slack, calls } = output()
  await slack.whisper(message, 'U9', 'La pregunta ya fue respondida.')
  assert.equal(calls[0].method, 'chat.postEphemeral')
  assert.equal(calls[0].args.thread_ts, '100.1')
  assert.equal(calls[0].args.user, 'U9')
})

test('a question at a room root keeps its note at the root', async () => {
  const { slack, calls } = output()
  await slack.whisper({ ...message, thread: null }, 'U9', 'Opcion invalida.')
  assert.equal(calls[0].args.thread_ts, undefined)
})
