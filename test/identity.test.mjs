import assert from 'node:assert/strict'
import { resolveIdentity } from '../src/identity.ts'
import { createIdentityResolver } from '../src/slack-identity.ts'
import { Core } from '../src/core.ts'
import { Store } from '../src/store.ts'
import { ConfigSchema } from '../src/config.ts'

let clock = 0, calls = 0
let user = { id: 'U1', team_id: 'T1', profile: { real_name: 'Person One', email: 'one@example.com' } }
const resolver = createIdentityResolver(async (method, args) => {
  assert.equal(method, 'users.info'); assert.equal(args.user, 'U1'); calls++
  return { user }
}, 'T1', () => clock)
assert.deepEqual(await resolver('U1'), { name: 'Person One', email: 'one@example.com' })
await resolver('U1'); assert.equal(calls, 1)
clock += 300001
user = { id: 'U1', team_id: 'T1', profile: { real_name: null, display_name: 'Other\nName', email: '' } }
assert.deepEqual(await resolver('U1'), { name: 'Other Name' })
assert.equal(calls, 2)
for (const invalid of [{ id: 'U2', team_id: 'T1' }, { id: 'U1', team_id: 'T2' }, { id: 'U1', team_id: 'T1', deleted: true }, { id: 'U1', team_id: 'T1', is_bot: true }]) {
  const lookup = createIdentityResolver(async () => ({ user: { ...invalid, profile: { real_name: 'Wrong', email: 'wrong@example.com' } } }), 'T1')
  assert.deepEqual(await lookup('U1'), {})
}
const partial = createIdentityResolver(async () => ({ user: { id: 'U1', team_id: 'T1', profile: {} } }), 'T1')
assert.deepEqual(await partial('U1'), {})
let attempts = 0
const failing = createIdentityResolver(async () => { attempts++; throw new Error('missing_scope') }, 'T1', () => clock)
assert.deepEqual(await failing('U1'), {})
await failing('U1'); assert.equal(attempts, 1)
clock += 30001; await failing('U1'); assert.equal(attempts, 2)
const signal = new AbortController().signal
assert.deepEqual(await resolveIdentity(async () => { throw new Error('offline') }, 'U1', signal), {})
let timedSignal
assert.deepEqual(await resolveIdentity((_id, abort) => { timedSignal = abort; return new Promise(() => {}) }, 'U1', signal, 10), {})
assert.equal(timedSignal.aborted, true)

const store = new Store(':memory:')
const prompts = []
const core = new Core({ store, config: ConfigSchema.parse({ auth: { mode: 'indie' }, repos: { path: process.cwd() }, slack: { workspace_team_id: 'T1', allowed_users: ['U1', 'U2'] } }), cwd: process.cwd(),
  output: Object.fromEntries(['notice', 'status', 'delta', 'finish'].map(k => [k, async () => {}])),
  runner: opts => { prompts.push(opts.prompt); return { done: Promise.resolve({ state: 'completed', text: 'ok', error: '', cost: 0, usage: {} }), cancel() {} } } })
const input = (eventId, author, text = 'my task') => ({ adapter: 'slack', eventId, key: 'slack:C1:1', author, team: 'T1', channel: 'C1', thread: '1', text })
const drain = async () => { while (core.active.size) await Promise.allSettled([...core.active.values()].map(a => a.done)) }
try {
  core.identities = async id => ({ name: `Person ${id}`, email: `${id}@example.com` })
  for (const id of ['U1', 'U2']) { await core.submit(input(id, id)); await drain() }
  for (let i = 0; i < 2; i++) {
    const state = JSON.parse(prompts[i].split('Estado del core: ')[1].split('\n')[0])
    assert.equal(state.author.id, `U${i + 1}`)
    assert.equal(state.author.email, `U${i + 1}@example.com`)
    assert.equal(state.author.team_id, 'T1')
  }
  let entered = false, lookupSignal
  core.identities = (_id, abort) => { entered = true; lookupSignal = abort; return new Promise(() => {}) }
  await core.submit(input('slow', 'U1'))
  while (!entered) await new Promise(r => setTimeout(r, 1))
  await core.submit(input('stop', 'U1', 'stop'))
  await drain()
  assert.equal(lookupSignal.aborted, true)
  assert.equal(prompts.length, 2, 'stop must not launch a runner after identity lookup')
  entered = false
  await core.submit(input('shutdown', 'U1', 'continua'))
  while (!entered) await new Promise(r => setTimeout(r, 1))
  await core.close()
  assert.equal(core.active.size, 0)
  assert.equal(prompts.length, 2, 'shutdown must not launch a runner after identity lookup')
} finally { await core.close(); store.close() }
console.log('Identity: optional profiles, TTL, API failure, timeout, per-turn authors and cancellation passed')
