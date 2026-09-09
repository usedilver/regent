import assert from 'node:assert/strict'
import { Store } from '../src/store.ts'
import { activityEvent, activityView } from '../src/activities.ts'
import { SlackActivities } from '../src/slack-activities.ts'
import { normalizeEvent } from '../src/runner.ts'
import { commandDisplay } from '../src/command-display.ts'

for (const command of ['pnpm test', 'npm run build', 'yarn lint', 'git diff --stat']) {
  assert.equal(commandDisplay(command)?.command, command)
  const state = { calls: {} }
  activityEvent(state, { kind: 'tool_use', id: 'bash', name: 'Bash', input: { command } })
  assert.ok(activityView(state).tasks[0].title.includes(command))
  assert.equal(activityView(state).tasks[0].details, command)
}
for (const command of [undefined, {}, 'pnpm test\n',
  'TOKEN=secret pnpm test', 'git -C /private/repo status',
  'curl https://example.com', 'echo secret', 'bash -c "pnpm test"',
  'pnpm test $(env)', 'pnpm test `env`', 'npm run private-client', 'pnpm test\u001b[0m']) {
  assert.equal(commandDisplay(command), undefined)
  const state = { calls: {} }
  activityEvent(state, { kind: 'tool_use', id: 'bash', name: 'Bash', input: { command, description: 'secret' } })
  assert.equal(activityView(state).tasks[0].title, 'Ejecutando comandos: Bash')
  assert.equal(Object.values(state.calls)[0].command, undefined)
  assert.ok(!JSON.stringify(state).includes('secret'))
}
for (const [command, operation] of [
  ['gh repo view private-repo --json name 2>&1', 'gh repo view'],
  ['which vercel && vercel --version 2>&1 || echo secret', 'which vercel'],
  ['vercel ls 2>&1 | grep private-project || echo secret', 'vercel ls'],
  ['pnpm test --token secret', 'pnpm test'],
  ['pnpm test && echo secret', 'pnpm test'],
  ['pnpm test > private-file', 'pnpm test'],
  ['pnpm test # secret', 'pnpm test'],
  ['git diff private-file', 'git diff'],
]) {
  const expected = `${operation} [argumentos y resto ocultos]`
  assert.equal(commandDisplay(command)?.command, expected)
  const state = { calls: {} }
  activityEvent(state, { kind: 'tool_use', id: 'bash', name: 'Bash', input: { command } })
  assert.equal(activityView(state).tasks[0].details, expected)
  assert.ok(!JSON.stringify(state).includes('secret'))
  assert.ok(!JSON.stringify(state).includes('private'))
}

const state = { calls: {} }
const mixed = { calls: {
  a: { group: 'command', tool: 'Bash', status: 'complete' },
  b: { group: 'command', tool: 'Bash', status: 'error' },
  c: { group: 'command', tool: 'Bash', status: 'running' },
} }
assert.equal(activityView(mixed).tasks[0].output, '1 ejecucion terminada\n1 con error\n1 en curso')
assert.match(activityView({ ...mixed, terminal: 'completed' }).tasks[0].output, /\n1 sin confirmar$/)
const use = { kind: 'tool_use', id: 'one', name: 'Read', input: { password: 'secret-value' } }
assert.equal(activityEvent(state, use), true)
assert.equal(activityEvent(state, use), false)
activityEvent(state, { ...use, parentId: 'parallel' })
assert.equal(Object.keys(state.calls).length, 2)
assert.equal(activityEvent(state, { kind: 'tool_result', id: 'missing' }), false)
assert.equal(activityEvent(state, { kind: 'tool_result', id: 'one', background: true }), false)
activityEvent(state, { kind: 'tool_result', id: 'one' })
assert.equal(activityView(state).tasks[0].status, 'in_progress')
state.terminal = 'interrupted'
assert.equal(activityView(state).tasks[0].status, 'error')
assert.ok(!JSON.stringify(state).includes('secret-value'))
assert.ok(!activityView(state).text.includes('secret-value'))
assert.equal(activityEvent(state, { ...use, id: 'late' }), false)
const normalized = normalizeEvent({ type: 'user', parent_tool_use_id: 'p', tool_use_result: { agentId: 'sync-agent' }, message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'done' }] } })
assert.equal(normalized[0].id, 'x')
assert.equal(normalized[0].parentId, 'p')
assert.equal(normalized[0].background, false)

const store = new Store(':memory:')
let calls = [], fail = false
const api = async (method, args) => {
  calls.push({ method, args })
  if (fail) { fail = false; throw new Error('invalid_blocks') }
  return { ts: '2' }
}
let activities = new SlackActivities(api, store)
const create = (key, thread = '1') => {
  const input = { adapter: 'slack', key, eventId: key, channel: 'C1', thread, author: 'U1', team: 'T1', text: 'test' }
  const accepted = store.accept(input, process.cwd(), 24)
  store.start(accepted.runId)
  return [store.conversation(key), store.run(accepted.runId)]
}
const flush = async run => {
  const record = activities.get(run.id)
  if (record) { record.nextAt = 0; activities.save(run.id, record) }
  await activities.flush()
}
try {
  const [c, run] = create('stream')
  activities.event(c, run, use)
  await activities.flush()
  assert.equal(calls[0].method, 'chat.startStream')
  assert.equal(calls[0].args.chunks[0].id, 'read')
  assert.equal(calls[0].args.task_display_mode, 'timeline')
  assert.match(calls[0].args.chunks[0].title, /Read/)
  assert.ok(!('output' in calls[0].args.chunks[0]))
  activities.event(c, run, { kind: 'tool_result', id: 'one' })
  await activities.flush()
  store.finish(run.id, 'completed', '', '')
  activities.terminal(run)
  await flush(run)
  assert.ok(calls.some(c => c.method === 'chat.stopStream'))
  assert.equal(calls.at(-1).args.blocks[1].status, 'complete')
  assert.equal(calls.at(-1).args.blocks[1].type, 'task_card')
  const list = calls.at(-1).args.blocks[1].output.elements[0]
  assert.equal(list.type, 'rich_text_list')
  assert.equal(list.style, 'bullet')
  const payload = activities.payload({ state: mixed, mode: 'blocks' })
  assert.deepEqual(payload.blocks[1].output.elements[0].elements.map(item => item.elements[0].text),
    ['1 ejecucion terminada', '1 con error', '1 en curso'])
  assert.match(JSON.stringify(calls.at(-1).args.blocks[1].details), /Read/)
  const count = calls.length
  activities = new SlackActivities(api, store)
  await flush(run)
  assert.equal(calls.length, count, 'Delivered terminal snapshot survives adapter restart')

  calls = []
  const [room, roomRun] = create('room', null)
  activities.event(room, roomRun, use)
  await activities.flush()
  assert.equal(calls[0].method, 'chat.postMessage')
  assert.equal(calls[0].args.thread_ts, undefined)
  store.finish(roomRun.id, 'interrupted', '', '')
  activities = new SlackActivities(api, store)
  await flush(roomRun)
  assert.equal(calls.at(-1).args.blocks[1].status, 'error')

  calls = []; fail = true
  const [fallback, fallbackRun] = create('fallback', null)
  activities.event(fallback, fallbackRun, use)
  await activities.flush()
  await flush(fallbackRun)
  assert.equal(calls.at(-1).args.blocks[0].text.type, 'plain_text')

  calls = []
  const [moving, movingRun] = create('moving')
  activities.event(moving, movingRun, use)
  await activities.flush()
  const record = activities.get(movingRun.id)
  record.desired = { ...record.desired, channel: 'C2', thread: undefined }
  record.revision++; activities.save(movingRun.id, record)
  await flush(movingRun)
  assert.ok(calls.some(c => c.method === 'chat.stopStream'))
  assert.ok(calls.some(c => c.method === 'chat.postMessage' && c.args.channel === 'C2'))
  assert.ok(!JSON.stringify(calls).includes('secret-value'))

  // An event arriving while HTTP is in flight must remain pending after receipt.
  let release
  const gate = new Promise(resolve => { release = resolve })
  calls = []
  activities = new SlackActivities(async (method, args) => {
    calls.push({ method, args })
    if (method === 'chat.startStream') await gate
    return { ts: '3' }
  }, store)
  const [racing, racingRun] = create('racing')
  activities.event(racing, racingRun, use)
  activities.event(racing, racingRun, { kind: 'tool_result', id: 'one', error: true })
  release()
  await activities.flush()
  assert.notEqual(activities.get(racingRun.id).sent, activities.get(racingRun.id).revision)
  await flush(racingRun)
  assert.equal(calls.at(-1).args.chunks[0].status, 'error')

  // Invalid append format closes the old stream before falling back in place.
  activities = new SlackActivities(api, store)
  const [rejecting, rejectingRun] = create('rejecting')
  activities.event(rejecting, rejectingRun, use)
  await activities.flush()
  activities.event(rejecting, rejectingRun, { kind: 'tool_result', id: 'one' })
  await activities.flush()
  calls = []; fail = true
  await flush(rejectingRun)
  assert.equal(calls[0].method, 'chat.appendStream')
  assert.equal(calls[1].method, 'chat.stopStream')
  await flush(rejectingRun)
  assert.equal(calls.at(-1).method, 'chat.update')
  assert.equal(activities.get(rejectingRun.id).ts, '2')
  for (const call of calls.filter(c => c.args.chunks)) {
    for (const chunk of call.args.chunks) {
      assert.ok(!('output' in chunk), 'Never append a full counter snapshot')
      assert.ok(!('details' in chunk), 'Never append repeated tool lists')
    }
  }
  console.log('Activity correlation, privacy, stream lifecycle, rooms, recovery, fallback and moves passed')
} finally { store.close() }
