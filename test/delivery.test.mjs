import assert from 'node:assert/strict'
import { DurableOutput } from '../src/delivery.ts'
import { redact, redactDeep } from '../src/store.ts'
import { Store } from '../src/store.ts'

let failed = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  OK ${name}`) } catch (error) { failed++; console.error(`  FAIL ${name}: ${error.stack}`) }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 15))
const permanent = () => Object.assign(new Error('An API error occurred: msg_too_long'), { data: { error: 'msg_too_long' } })
const base = (over = {}) => ({ async notice() {}, async status() {}, async delta() {}, async finish() {}, ...over })

await check('permanent Slack error dead-letters on the first attempt and warns the thread', async () => {
  const store = new Store(':memory:')
  const notices = []
  const durable = new DurableOutput(store, base({ async notice(c, t) { notices.push(t) }, async finish() { throw permanent() } }))
  const c = { key: 'slack:C1:1', channel: 'C1', thread: '1' }
  await durable.finish(c, { id: 'r1' }, 'x'.repeat(5000))
  const row = store.db.prepare("SELECT state,attempts FROM deliveries WHERE kind='finish'").get()
  assert.equal(row.state, 'failed')
  assert.equal(row.attempts, 1)
  await tick()
  assert.equal(notices.length, 1)
  assert.match(notices[0], /respuesta final/i)
  store.close()
})

await check('unparseable args are dead-lettered, never delivered', async () => {
  const store = new Store(':memory:')
  let delivered = false
  const durable = new DurableOutput(store, base({ async notice() { delivered = true } }))
  store.db.prepare('INSERT INTO deliveries(conversation_key,kind,args) VALUES(?,?,?)').run('slack:C2:1', 'notice', '{bad json')
  await durable.flush()
  assert.equal(store.db.prepare("SELECT state FROM deliveries WHERE conversation_key='slack:C2:1'").get().state, 'failed')
  assert.equal(delivered, false)
  store.close()
})

await check('a finish with unreadable args still warns its thread, located by conversation key', async () => {
  const store = new Store(':memory:')
  const notices = []
  const durable = new DurableOutput(store, base({ async notice(c, t) { notices.push([c.channel, t]) } }))
  store.db.prepare('INSERT INTO conversations(key,adapter,channel,thread,author,cwd,updated_at) VALUES(?,?,?,?,?,?,?)').run('slack:C5:1', 'slack', 'C5', '1', 'U1', '/tmp', Date.now())
  store.db.prepare('INSERT INTO deliveries(conversation_key,kind,args) VALUES(?,?,?)').run('slack:C5:1', 'finish', '{bad json')
  await durable.flush()
  assert.equal(store.db.prepare("SELECT state FROM deliveries WHERE conversation_key='slack:C5:1'").get().state, 'failed')
  await tick()
  assert.equal(notices.length, 1)
  assert.equal(notices[0][0], 'C5')
  assert.match(notices[0][1], /ilegible/i)
  store.close()
})

await check('a poison delivery does not block later deliveries in the same conversation', async () => {
  const store = new Store(':memory:')
  const delivered = []
  const durable = new DurableOutput(store, base({ async notice(c, t) { delivered.push(t) }, async finish() { throw permanent() } }))
  const c = { key: 'slack:C3:1', channel: 'C3', thread: '1' }
  store.db.prepare('INSERT INTO deliveries(conversation_key,kind,args) VALUES(?,?,?)').run(c.key, 'finish', JSON.stringify([c, { id: 'r' }, 'y'.repeat(4500)]))
  store.db.prepare('INSERT INTO deliveries(conversation_key,kind,args) VALUES(?,?,?)').run(c.key, 'notice', JSON.stringify([c, 'seguimiento']))
  await durable.flush()
  assert.equal(store.db.prepare("SELECT state FROM deliveries WHERE kind='finish'").get().state, 'failed')
  assert.ok(delivered.includes('seguimiento'))
  assert.equal(store.db.prepare("SELECT count(*) c FROM deliveries WHERE state='pending'").get().c, 0)
  store.close()
})

await check('a transient error is retried, and dead-lettered only once it exhausts the attempt cap', async () => {
  const store = new Store(':memory:')
  const durable = new DurableOutput(store, base({ async notice() { throw new Error('flaky network') } }))
  const c = { key: 'slack:C4:1', channel: 'C4' }
  const args = JSON.stringify([c, 'hola'])
  store.db.prepare('INSERT INTO deliveries(conversation_key,kind,args) VALUES(?,?,?)').run(c.key, 'notice', args)
  await durable.flush()
  let row = store.db.prepare("SELECT state,attempts FROM deliveries WHERE conversation_key='slack:C4:1'").get()
  assert.equal(row.state, 'pending')
  assert.equal(row.attempts, 1)
  store.db.prepare("UPDATE deliveries SET attempts=24 WHERE conversation_key='slack:C4:1'").run()
  await durable.flush()
  row = store.db.prepare("SELECT state FROM deliveries WHERE conversation_key='slack:C4:1'").get()
  assert.equal(row.state, 'failed')
  store.close()
})

await check('redactDeep redacts string values while keeping the JSON parseable', async () => {
  const bad = { text: 'db secret: hunter2"trailing', token: 'sk-ant-abc123' }
  // The old approach — redacting the serialized JSON — corrupts structure on an escaped quote.
  assert.throws(() => JSON.parse(redact(JSON.stringify(bad))))
  const restored = JSON.parse(JSON.stringify(redactDeep(bad)))
  assert.ok(!restored.text.includes('hunter2'))
  assert.ok(!restored.token.includes('abc123'))
  assert.ok(restored.text.includes('[REDACTED]'))
})

if (failed) process.exitCode = 1
else console.log('delivery durability, dead-lettering and redaction passed')
