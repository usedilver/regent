import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Store } from '../src/storage/store.ts'
import { redactDeep } from '../src/storage/redact.ts'

test('structured and embedded JSON secrets are redacted without corrupting their envelope', () => {
  const value = 'audit-fixture-value'
  const original = {
    password: value,
    nested: [{ accessToken: value, 'X-API-Key': value }],
    headers: { authorization: value, cookie: value },
    MYSQL_PASSWORD: 1234,
    PGPASSWORD: value,
    empty_secret: null,
    usage: { input_tokens: 27 },
    text: JSON.stringify({ client_secret: value }),
  }
  const result = JSON.parse(JSON.stringify(redactDeep(original)))
  assert.doesNotMatch(JSON.stringify(result), /audit-fixture-value|1234/)
  assert.equal(result.password, '[REDACTED]')
  assert.equal(result.empty_secret, null)
  assert.equal(result.usage.input_tokens, 27)
  assert.equal(JSON.parse(result.text).client_secret, '[REDACTED]')
  assert.equal(original.password, value)
})

test('stored tool events retain activity transitions without raw arguments or results', () => {
  const store = new Store(':memory:')

  try {
    const { runId } = store.accept(
      {
        adapter: 'cli',
        eventId: 'audit',
        key: 'audit',
        author: 'fixture',
        channel: 'fixture',
        text: 'fixture',
        intent: 'ask',
      },
      process.cwd(),
      24,
    )

    store.event(runId, 'tool_use', {
      id: 'one',
      name: 'Bash',
      input: {
        command: 'gh api /private --field password=fixture-secret',
        password: 'fixture-secret',
      },
    })
    store.event(runId, 'tool_result', {
      id: 'one',
      error: true,
      background: false,
      content: 'fixture-secret',
    })
    store.event(runId, 'tool_use', {
      id: 'two',
      name: 'Write',
      input: { content: 'fixture-secret' },
    })
    const events = store.db
      .prepare('SELECT data FROM events ORDER BY id')
      .all()
      .map((row) => JSON.parse(row.data))

    assert.doesNotMatch(JSON.stringify(events), /fixture-secret|\/private/)
    assert.equal(events[0].input.command, 'gh api [argumentos y resto ocultos]')
    assert.equal(events[1].id, 'one')
    assert.equal(events[1].error, true)
    assert.equal(events[1].background, false)
    assert.equal(events[2].name, 'Write')
    assert.equal(events[2].input, undefined)
  } finally {
    store.close()
  }
})
