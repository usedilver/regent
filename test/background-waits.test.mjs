import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BackgroundTasks } from '../src/execution/background-tasks.ts'
import { startRunner } from '../src/execution/runner.ts'

const snapshot = (tasks) => ({ type: 'system', subtype: 'background_tasks_changed', tasks })
const start = (id, extra = {}) => ({
  type: 'system',
  subtype: 'task_started',
  task_id: id,
  ...extra,
})
const end = (id, status = 'completed', extra = {}) => ({
  type: 'system',
  subtype: 'task_notification',
  task_id: id,
  status,
  ...extra,
})

test('live snapshots replace the whole set and override late lifecycle events', () => {
  const tasks = new BackgroundTasks()
  assert.equal(tasks.running, false)
  tasks.observe(snapshot([{ task_id: 'build' }, { task_id: 'watch', ambient: true }]))
  assert.equal(tasks.running, true)
  tasks.observe(end('build'))
  assert.equal(tasks.running, true, 'Snapshots and lifecycle events have unspecified ordering')
  tasks.observe(snapshot([{ task_id: 'watch', ambient: true }]))
  assert.equal(tasks.running, false)
  tasks.observe(start('build'))
  assert.equal(tasks.running, false, 'A late start cannot resurrect a task removed by a snapshot')
  tasks.observe(snapshot([{ task_id: 'second-build' }]))
  assert.equal(tasks.running, true)
  tasks.observe(snapshot([]))
  assert.equal(tasks.running, false)
  assert.equal(new BackgroundTasks().running, false, 'New CLI processes never inherit tasks')
})

test('legacy lifecycle tracking handles all terminal states and resumed task runs', () => {
  for (const status of ['completed', 'failed', 'stopped', 'killed']) {
    const tasks = new BackgroundTasks()
    tasks.observe(start('build', { is_backgrounded: true }))
    assert.equal(tasks.running, true)
    tasks.observe({ type: 'system', subtype: 'task_updated', task_id: 'build', patch: { status } })
    assert.equal(tasks.running, false, status)
  }
  const tasks = new BackgroundTasks()
  tasks.observe(start('agent', { run_id: '01' }))
  tasks.observe(end('agent', 'completed', { run_id: '01' }))
  assert.equal(tasks.running, false)
  tasks.observe(start('agent', { run_id: '02' }))
  tasks.observe(end('agent', 'completed', { run_id: '01' }))
  assert.equal(tasks.running, true, 'An earlier run completion cannot close a resumed agent')
  tasks.observe(end('agent', 'failed', { run_id: '02' }))
  tasks.observe(start('agent', { run_id: '02' }))
  assert.equal(tasks.running, false, 'A duplicate start cannot reopen the completed run')
})

test('foreground and ambient work do not exempt quiet streams', () => {
  const tasks = new BackgroundTasks()
  tasks.observe(start('watch', { ambient: true }))
  tasks.observe(start('foreground', { is_backgrounded: false }))
  assert.equal(tasks.running, false)
  tasks.observe({
    type: 'system',
    subtype: 'task_updated',
    task_id: 'foreground',
    patch: { is_backgrounded: true },
  })
  assert.equal(tasks.running, true)
  tasks.observe(end('foreground'))
  assert.equal(tasks.running, false)
})

const shellUse = (name = 'Bash') => ({
  type: 'assistant',
  message: {
    content: [{ type: 'tool_use', id: 'call', name, input: { run_in_background: true } }],
  },
})
const shellResult = (structured, isError = false) => ({
  type: 'user',
  tool_use_result: structured,
  message: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'call',
        is_error: isError,
        content: 'Command running in background with ID: build',
      },
    ],
  },
})

test('legacy shell fallback requires a correlated successful structured result', () => {
  for (const [name, structured, isError, expected] of [
    ['Bash', { backgroundTaskId: 'build' }, false, true],
    ['PowerShell', { backgroundTaskId: 'build' }, false, true],
    ['Bash', {}, false, false],
    ['Bash', { backgroundTaskId: 'build' }, true, false],
    ['mcp__fixture__query', { backgroundTaskId: 'build' }, false, false],
  ]) {
    const tasks = new BackgroundTasks()
    tasks.observe(shellUse(name))
    tasks.observe(shellResult(structured, isError))
    assert.equal(tasks.running, expected)
    tasks.observe(end('build'))
    assert.equal(tasks.running, false)
  }
  const tasks = new BackgroundTasks()
  tasks.observe(shellUse())
  tasks.observe(end('build'))
  tasks.observe(shellResult({ backgroundTaskId: 'build' }))
  assert.equal(tasks.running, false, 'A fast completion before the shell result is not reopened')
  const unrelated = new BackgroundTasks()
  unrelated.observe(shellUse())
  unrelated.observe({
    ...shellResult({ backgroundTaskId: 'build' }),
    parent_tool_use_id: 'other-agent',
  })
  assert.equal(unrelated.running, false)
  const moved = new BackgroundTasks()
  moved.observe(start('build', { is_backgrounded: false }))
  moved.observe(shellUse())
  moved.observe(shellResult({ backgroundTaskId: 'build' }))
  assert.equal(
    moved.running,
    true,
    'A structured result confirms a foreground shell was backgrounded',
  )
})

test('malformed snapshots and ordinary output do not disable the watchdog', () => {
  for (const raw of [
    snapshot(null),
    snapshot([{}]),
    snapshot([{ task_id: '' }]),
    { type: 'system', subtype: 'unknown', task_id: 'build' },
    { type: 'user', message: { content: 'task_started build' } },
    shellResult({ backgroundTaskId: 'build' }),
  ]) {
    const tasks = new BackgroundTasks()
    tasks.observe(raw)
    assert.equal(tasks.running, false)
  }
})

const prelude = `const emit = x => console.log(JSON.stringify(x));
emit({type:'system',subtype:'init',session_id:'fixture-session',mcp_servers:[]});`
const waiting = `emit({type:'result',result:'Waiting for build',total_cost_usd:0.01});`
const activeTask = `emit(${JSON.stringify(snapshot([{ task_id: 'build', task_type: 'local_bash' }]))});`
const idleTasks = `emit(${JSON.stringify(snapshot([]))});`
const hold = 'setInterval(() => {}, 1000);'

function runner(t, script, overrides = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'regent-background-test-'))
  const events = []
  const handle = startRunner({
    cwd,
    prompt: 'fixture',
    runId: 'fixture',
    toolsUrl: 'http://127.0.0.1:1/tools',
    token: 'synthetic',
    readonlyMcp: [],
    command: process.execPath,
    prefixArgs: ['-e', prelude + script, '--'],
    timeoutMs: 2500,
    stallMs: 150,
    graceMs: 30,
    onEvent(event) {
      events.push(event)
    },
    ...overrides,
  })
  t.after(async () => {
    handle.cancel()
    await handle.done
    fs.rmSync(cwd, { recursive: true, force: true })
  })
  return { handle, events }
}

test('a quiet background build outlives inactivity and delivers the later final result', async (t) => {
  const { handle } = runner(
    t,
    activeTask +
      waiting +
      `setTimeout(() => {
    ${idleTasks}
    setTimeout(() => emit({type:'result',result:'Build verified',total_cost_usd:0.03}), 20);
  }, 600);`,
  )
  const result = await handle.done
  assert.equal(result.state, 'completed', result.error)
  assert.equal(result.text, 'Build verified')
  assert.equal(result.cost, 0.03)
})

test('legacy background shell results also survive inactivity until notification', async (t) => {
  const messages = [shellUse(), shellResult({ backgroundTaskId: 'build' })]
    .map((m) => `emit(${JSON.stringify(m)});`)
    .join('')
  const { handle } = runner(
    t,
    messages +
      waiting +
      `setTimeout(() => {
    emit(${JSON.stringify(end('build'))});
    emit({type:'result',result:'Legacy build verified'});
  }, 600);`,
  )
  const result = await handle.done
  assert.equal(result.state, 'completed', result.error)
  assert.equal(result.text, 'Legacy build verified')
})

test('a completed background task restores inactivity detection if the CLI then hangs', async (t) => {
  const { handle } = runner(
    t,
    activeTask + waiting + `setTimeout(() => { ${idleTasks} }, 400);` + hold,
  )
  const result = await handle.done
  assert.equal(result.state, 'interrupted')
  assert.equal(result.failure.code, 'run_stalled')
})

test('a background task that never finishes is still bounded by the total run deadline', async (t) => {
  const { handle } = runner(t, activeTask + waiting + hold, { timeoutMs: 500 })
  const result = await handle.done
  assert.equal(result.state, 'interrupted')
  assert.equal(result.failure.code, 'run_timeout')
})

test('user cancellation escalates even while confirmed background work ignores signals', async (t) => {
  const { handle, events } = runner(
    t,
    activeTask +
      waiting +
      `process.on('SIGINT', () => {}); process.on('SIGTERM', () => {});` +
      hold,
  )
  const deadline = Date.now() + 2000
  while (!events.some((e) => e.kind === 'result')) {
    if (Date.now() > deadline) throw new Error('CLI did not start its background task')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  handle.cancel('Detenido por el usuario')
  const result = await handle.done
  assert.equal(result.state, 'interrupted')
  assert.equal(result.error, 'Detenido por el usuario')
})

test('a result by itself and ambient watchers cannot hide a stuck CLI', async (t) => {
  const { handle } = runner(
    t,
    `emit(${JSON.stringify(snapshot([{ task_id: 'watch', ambient: true }]))});` + waiting + hold,
  )
  const result = await handle.done
  assert.equal(result.state, 'interrupted')
  assert.equal(result.failure.code, 'run_stalled')
})
