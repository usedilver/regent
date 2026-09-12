import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import { RoomTransfers } from '../src/rooms.ts'
import { createRoomApi, conversationRoute, SlackOutput } from '../src/slack.ts'
import { Core } from '../src/core.ts'
import { ConfigSchema } from '../src/config.ts'
import { DurableOutput } from '../src/delivery.ts'
import { isolationFor } from '../src/repository.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'regent-rooms-'))
const file = path.join(root, 'state.sqlite')
let store = new Store(file), core, output
const signal = new AbortController().signal
const input = (key, eventId = key) => ({ adapter: 'slack', key, channel: 'D1', team: 'T1', author: 'U1', eventId, text: 'Create a room' })
const rooms = new Map(), invites = [], notices = [], questions = []
let creates = 0, failInvite = false, loseCreate = false, online = true
const api = {
  async validateUser(id) { if (id === 'UINVALID') throw new Error('invalid user') },
  async find(name) { return rooms.get(name) },
  async create(name) {
    creates++
    const channel = `C${creates}`
    rooms.set(name, channel)
    if (loseCreate) { loseCreate = false; throw new Error('timeout after creation') }
    return channel
  },
  async invite(channel, id) { if (failInvite) throw new Error('invite failed'); invites.push([channel, id]) },
}
const delegate = {
  async notice(c, text) { if (!online) throw new Error('offline'); notices.push({ c, text }) },
  async status() {}, async delta() {}, async finish() {}, async moved() {},
  async question(c, question) { questions.push({ c, question }) },
}
const until = async fn => { for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)) } throw new Error('Timed out') }
try {
  const key = 'slack:D1:1'
  const first = store.accept({ ...input(key), thread: '1' }, root, 24)
  store.session(key, 'same-session')
  const original = store.conversation(key)
  const isolation = isolationFor(root, key)
  let transfers = new RoomTransfers(store)
  await assert.rejects(() => transfers.prepare(original, { name: 'review', summary: 'Context', users: ['UINVALID'] }, api, signal), /invalid user/)
  assert.equal(creates, 0)
  failInvite = true
  await assert.rejects(() => transfers.prepare(original, { name: 'review', summary: 'Context', users: ['U2'] }, api, signal), /invite failed/)
  assert.equal(store.conversation(key).channel, 'D1')
  assert.equal(creates, 1)
  const preparingRoute = conversationRoute(store, { channel: 'C1', ts: '2' })
  assert.equal(preparingRoute.pending, true)
  assert.equal(preparingRoute.key, key)
  store.close()
  store = new Store(file)
  transfers = new RoomTransfers(store)
  failInvite = false
  const transfer = await transfers.prepare(original, { name: 'retry', summary: 'Retry' }, api, signal)
  assert.equal(creates, 1)
  assert.equal(transfer.channel, 'C1')
  assert.ok(invites.some(([channel, id]) => channel === 'C1' && id === 'U2'))
  store.start(first.runId)
  const queued = store.accept(input(key, 'queued'), root, 24)
  store.db.prepare("INSERT INTO gates(conversation_key,question,state,question_id,options,destination) VALUES(?,?,'pending',?,?,?)")
    .run(key, 'Choose', 'question1', JSON.stringify(['A', 'B']), JSON.stringify(original))
  store.db.prepare("INSERT INTO deliveries(conversation_key,kind,args) VALUES(?,'question',?)")
    .run(key, JSON.stringify([original, { id: 'question1', text: 'Choose', options: ['A', 'B'] }]))
  transfers.move(key, 'C1')
  transfers.move(key, 'C1')
  const destination = store.conversation(key)
  assert.equal(destination.channel, 'C1')
  assert.equal(destination.thread, null)
  assert.equal(destination.cwd, root)
  assert.equal(destination.session_id, 'same-session')
  assert.equal(conversationRoute(store, { channel: 'D1', ts: '2', thread_ts: '1' }).redirect, 'C1')
  assert.equal(conversationRoute(store, { channel: 'D1', ts: '2' }).redirect, undefined)
  for (const thread_ts of [undefined, 'room-thread']) {
    const route = conversationRoute(store, { channel: 'C1', ts: '3', thread_ts })
    assert.equal(route.key, key)
    assert.equal(route.room, true)
    assert.equal(route.pending, false)
    assert.equal(route.redirect, undefined)
  }
  assert.deepEqual(isolationFor(destination.cwd, destination.key), isolation)
  for (const id of [first.runId, queued.runId]) {
    assert.equal(store.run(id).reply_channel, 'C1')
    assert.equal(store.run(id).reply_thread, null)
  }
  assert.deepEqual(JSON.parse(store.db.prepare('SELECT source FROM conversation_history WHERE conversation_key=?').get(key).source), { channel: 'C1' })
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0)
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n, 5)
  store.close()
  store = new Store(file)
  output = new DurableOutput(store, delegate)
  await output.flush()
  await output.flush()
  assert.equal(notices.length, 2)
  assert.equal(notices[0].c.channel, 'D1')
  assert.match(notices[0].text, /<#C1>/)
  assert.equal(notices[1].c.channel, 'C1')
  assert.equal(questions.length, 1)
  assert.equal(questions[0].c.channel, 'C1')
  assert.equal(questions[0].question.id, 'question1')
  store.state(key, 'idle')
  store.db.prepare('UPDATE conversations SET updated_at=0 WHERE key=?').run(key)
  store.accept({ ...input(key, 'later'), channel: 'C1' }, root, 24)
  assert.equal(store.conversation(key).session_id, 'same-session')
  console.log('  OK durable move, same session/repo/worktree, queued runs, questions and DM idle reset')

  const lostKey = 'lost-response'
  store.accept(input(lostKey), root, 24)
  transfers = new RoomTransfers(store)
  loseCreate = true
  await assert.rejects(() => transfers.prepare(store.conversation(lostKey), { name: 'lost', summary: 'Recover' }, api, signal), /timeout/)
  store.close()
  store = new Store(file)
  transfers = new RoomTransfers(store)
  const recovered = await transfers.prepare(store.conversation(lostKey), { name: 'lost', summary: 'Recover' }, api, signal)
  assert.equal(recovered.channel, 'C2')
  assert.equal(creates, 2)
  await assert.rejects(() => transfers.prepare(store.conversation(lostKey), { name: 'lost', summary: 'Recover' }, api, AbortSignal.abort()), /abort/i)
  assert.equal(transfers.get(lostKey).state, 'pending')
  console.log('  OK invitation failure and lost create response reuse the channel after restart; cancellation never moves')

  const threadKey = 'slack:CSOURCE:1'
  store.accept({ ...input(threadKey), channel: 'CSOURCE', thread: '1' }, root, 24)
  const threadRoom = await transfers.prepare(store.conversation(threadKey), { name: 'thread', summary: 'Thread context' }, api, signal)
  transfers.move(threadKey, threadRoom.channel)
  assert.equal(conversationRoute(store, { channel: 'CSOURCE', ts: '2', thread_ts: '1' }).redirect, threadRoom.channel)
  assert.equal(conversationRoute(store, { channel: 'CSOURCE', ts: '3', thread_ts: 'other' }).redirect, undefined)

  // Run the public tool through Core, including the active output destination.
  store.close()
  store = new Store(path.join(root, 'core.sqlite'))
  output = new DurableOutput(store, delegate)
  const config = ConfigSchema.parse({ auth: { mode: 'indie' }, repos: { path: root }, slack: { workspace_team_id: 'T1', allowed_users: ['U1'] } })
  core = new Core({ store, config, cwd: root, output, runner: options => {
    options.onEvent({ kind: 'init', sessionId: 'core-session' })
    let resolve
    const done = new Promise(r => { resolve = r })
    return { done, cancel: () => resolve({ state: 'interrupted', text: '', error: '', cost: 0, usage: {} }) }
  } })
  core.rooms = api
  await core.submit(input('slack:D1'))
  await until(() => [...core.active.values()][0]?.controller)
  const active = [...core.active.values()][0]
  online = false
  const result = await core.tool(active.token, 'regent_create_room', { name: 'discussion', summary: 'A discussion, not a task' })
  assert.equal(result.moved, true)
  assert.equal(active.conversation.channel, result.channel)
  assert.equal(active.run.reply_channel, result.channel)
  assert.equal(store.conversation('slack:D1').session_id, 'core-session')
  const again = await core.tool(active.token, 'regent_create_room', { name: 'again', summary: 'Again' })
  assert.equal(again.channel, result.channel)
  assert.equal(creates, 4)
  online = true
  await output.flush()
  const gate = { id: 'moved-question', text: 'Continue?', options: ['Yes', 'No'] }
  store.db.prepare("INSERT INTO gates(conversation_key,question,state,question_id,options,destination) VALUES(?,?,'pending',?,?,?)")
    .run('slack:D1', gate.text, gate.id, JSON.stringify(gate.options), JSON.stringify({ ...active.conversation, thread: null }))
  await assert.rejects(() => core.answerQuestion(gate.id, 0, 'U1', 'T1', 'D1', null), /otro hilo/)
  await core.answerQuestion(gate.id, 0, 'U1', 'T1', result.channel, null)
  assert.equal(store.db.prepare('SELECT state FROM gates WHERE question_id=?').get(gate.id).state, 'answered')
  await core.close()
  await output.close()
  console.log('  OK Core tool exposure, repeat requests, output outage and question button destination checks')

  const calls = []
  const slack = createRoomApi(async (method, args) => {
    calls.push({ method, args })
    if (method === 'users.info') return { user: { team_id: args.user === 'UOTHER' ? 'T2' : 'T1' } }
    if (method === 'conversations.create') { if (args.name === 'taken') throw new Error('name_taken'); return { channel: { id: 'CPRIVATE' } } }
    if (method === 'conversations.invite') throw new Error('already_in_channel')
    if (!args.cursor) return { channels: [{ name: 'taken', id: 'CFOREIGN', creator: 'OTHER', is_member: true }], response_metadata: { next_cursor: 'next' } }
    return { channels: [{ name: 'taken', id: 'COWN', creator: 'BOT', is_member: true }] }
  }, 'T1', () => 'BOT')
  await slack.validateUser('U1')
  await assert.rejects(() => slack.validateUser('UOTHER'), /workspace/)
  assert.equal(await slack.create('new'), 'CPRIVATE')
  assert.equal(calls.find(c => c.method === 'conversations.create').args.is_private, true)
  assert.equal(await slack.create('taken'), 'COWN')
  await slack.invite('COWN', 'U1')
  console.log('  OK private Slack rooms, workspace validation, pagination, ownership and idempotent invites')

  const streamCalls = []
  const streams = new SlackOutput(async (method, args) => {
    streamCalls.push({ method, args })
    return { ts: 'stream-ts' }
  }, 1)
  const run = { id: 'stream-run', author: 'U1' }
  const source = { key: 'stream-key', channel: 'CSOURCE', thread: '1', team: 'T1', author: 'U1' }
  await streams.delta(source, run, 'Before move\n')
  await until(() => streamCalls.some(c => c.method === 'chat.startStream'))
  await streams.moved(run)
  await streams.delta({ ...source, channel: 'CDEST', thread: null }, run, 'After move\n')
  await until(() => streamCalls.filter(c => c.method === 'chat.startStream').length === 2)
  await streams.finish({ ...source, channel: 'CDEST', thread: null }, run, 'Done')
  assert.deepEqual(streamCalls.filter(c => c.method === 'chat.startStream').map(c => c.args.channel), ['CSOURCE', 'CDEST'])
  assert.deepEqual(streamCalls.filter(c => c.method === 'chat.stopStream').map(c => c.args.channel), ['CSOURCE', 'CDEST'])
  assert.equal(streamCalls.find(c => c.method === 'chat.update').args.channel, 'CDEST')
  console.log('  OK stream closes in origin and subsequent output/authoritative result stay in the room')
} finally {
  if (core && !core.stopping) await core.close()
  if (output) await output.close()
  store.close()
  fs.rmSync(root, { recursive: true, force: true })
}
