import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Core } from '../src/core/core.ts'
import { Store } from '../src/storage/store.ts'
import { ConfigSchema } from '../src/config.ts'
import { startRunner } from '../src/execution/runner.ts'
import { ExternalMcp } from '../src/adapters/mcp/server.ts'

const init = `console.log(JSON.stringify({type:'system',subtype:'init',session_id:'fixture-session',mcp_servers:[]}));`
const partial = `console.log(JSON.stringify({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Estoy revisando el proyecto.'}}}));`
const hang = `${init}${partial}setInterval(() => {}, 1000);`
const input = (eventId, text = 'Explica el proyecto') => ({
  adapter: 'mcp',
  key: 'mcp:fixture:conversation',
  channel: 'mcp:fixture:conversation',
  author: 'mcp:fixture',
  eventId,
  text,
})

const until = async (predicate) => {
  const deadline = Date.now() + 5000

  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Execution outcome timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function fixture(t, script, overrides = {}, runner = startRunner) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-outcome-')))
  const store = new Store(':memory:')
  const config = ConfigSchema.parse({
    auth: { mode: 'indie' },
    repos: { path: root },
    slack: { workspace_team_id: 'T', allowed_users: [] },
    mcp: { enabled: true, principals: [{ id: 'fixture', token_env: 'REGENT_MCP_TOKEN_FIXTURE' }] },
  })
  const messages = []
  const starts = []
  const core = new Core({
    store,
    config,
    cwd: root,
    output: Object.fromEntries(
      ['notice', 'status', 'delta', 'finish'].map((kind) => [
        kind,
        async (...args) => {
          messages.push({ kind, args })
        },
      ]),
    ),
    runnerOverrides: {
      command: process.execPath,
      prefixArgs: ['-e', script, '--'],
      timeoutMs: 2000,
      stallMs: 1000,
      graceMs: 30,
      ...overrides,
    },
    runner: (options) => {
      starts.push(options)
      return runner(options)
    },
  })
  const mcp = new ExternalMcp(core, {
    REGENT_MCP_TOKEN_FIXTURE: 'synthetic-test-token-00000000000000000',
  })

  t.after(async () => {
    await core.close()
    store.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, store, core, messages, starts, mcp }
}

async function outcome(f) {
  const accepted = await f.core.submit(input('request'))
  await until(() => !f.core.active.size)
  const run = f.store.run(accepted.runId)
  const replies = f.messages.filter((message) => message.kind === 'finish')
  assert.equal(replies.length, 1)
  assert.equal(f.starts.length, 1)
  return { run, reply: replies[0].args[2], status: f.mcp.status('mcp:fixture', run.id).run }
}

for (const scenario of [
  {
    name: 'nonzero exit',
    script: `${init}${partial}process.exitCode=7`,
    detail: /codigo 7/,
    source: 'claude',
  },
  {
    name: 'unexpected signal',
    script: `${init}${partial}process.kill(process.pid,'SIGTERM')`,
    detail: /SIGTERM/,
    source: 'claude',
  },
  {
    name: 'missing final result',
    script: `${init}${partial}`,
    detail: /sin evento result/,
    source: 'claude',
  },
  {
    name: 'invalid stream',
    script: `${init}console.log('invalid JSON')`,
    detail: /Stream de Claude invalido/,
    source: 'regent',
  },
  {
    name: 'executor startup',
    script: '',
    overrides: { command: '/nonexistent/regent-test-claude' },
    detail: /No pude iniciar Claude/,
    source: 'regent',
  },
]) {
  test(`${scenario.name}: deliver a final incomplete-work notice and expose the failure to MCP`, async (t) => {
    const f = fixture(t, scenario.script, scenario.overrides)
    const { run, reply, status } = await outcome(f)
    assert.equal(run.state, 'failed')
    assert.match(run.error, scenario.detail)
    assert.match(reply, /trabajo quedó incompleto/)
    assert.equal(status.failure.code, 'execution_failed')
    assert.equal(status.failure.source, scenario.source)
  })
}

for (const scenario of [
  {
    name: 'deadline',
    overrides: { timeoutMs: 150, stallMs: 1000 },
    code: 'run_timeout',
    message: /tiempo máximo/,
  },
  {
    name: 'no activity',
    overrides: { timeoutMs: 2000, stallMs: 150 },
    code: 'run_stalled',
    message: /dejó de emitir actividad/,
  },
]) {
  test(`${scenario.name}: interrupted work is labelled explicitly in the final reply and MCP status`, async (t) => {
    const f = fixture(t, hang, scenario.overrides)
    const { run, reply, status } = await outcome(f)
    assert.equal(run.state, 'interrupted')
    assert.match(reply, scenario.message)
    assert.match(reply, /trabajo quedó incompleto/)
    assert.equal(status.failure.code, scenario.code)
    assert.equal(status.failure.source, 'regent')
  })
}

test('a user stop overrides a concurrent Claude error and does not start queued work', async (t) => {
  let finish
  const f = fixture(t, '', {}, (options) => {
    options.onEvent({ kind: 'init', sessionId: 'fixture-session' })
    return {
      done: new Promise((resolve) => {
        finish = resolve
      }),
      cancel() {
        finish({
          state: 'failed',
          text: 'Prompt is too long',
          error: 'Claude termino con codigo 1',
          cost: 0,
          usage: {},
        })
      },
    }
  })
  const accepted = await f.core.submit(input('first'))
  await until(() => finish)
  const queued = await f.core.submit(input('queued', 'Después revisa la documentación'))
  await f.core.submit(input('stop', 'stop'))
  await until(() => !f.core.active.size)
  const run = f.store.run(accepted.runId)
  assert.equal(run.state, 'interrupted')
  assert.match(run.error, /Detenido por el usuario/)
  const replies = f.messages.filter((message) => message.kind === 'finish')
  assert.equal(replies.length, 1)
  assert.match(replies[0].args[2], /Detenido por el usuario/)
  assert.match(replies[0].args[2], /Respuesta parcial/)
  assert.equal(f.mcp.status('mcp:fixture', run.id).run.failure, undefined)
  assert.equal(f.store.run(queued.runId).state, 'queued')
  assert.equal(f.starts.length, 1)
})

test('a rejected executor promise still delivers and persists the terminal failure', async (t) => {
  const f = fixture(t, '', {}, () => ({
    done: Promise.reject(new Error('Synthetic executor failure')),
    cancel() {},
  }))
  const { run, reply, status } = await outcome(f)
  assert.equal(run.state, 'failed')
  assert.equal(run.error, 'Synthetic executor failure')
  assert.match(reply, /Regent encontró un error/)
  assert.equal(status.failure.source, 'regent')
})

test('stopping a recovered execution does not expose the previous attempt as a terminal failure', async (t) => {
  let finish
  const f = fixture(t, '', {}, (options) => {
    options.onEvent({ kind: 'init', sessionId: 'fixture-session' })

    if (options.sessionId) {
      return {
        done: Promise.resolve({
          state: 'failed',
          text: 'Prompt is too long',
          error: 'Prompt is too long',
          cost: 0,
          usage: {},
        }),
        cancel() {},
      }
    }

    return {
      done: new Promise((resolve) => {
        finish = resolve
      }),
      cancel() {
        finish({
          state: 'interrupted',
          text: 'Hallazgos parciales',
          error: 'Detenido por el usuario',
          cost: 0,
          usage: {},
        })
      },
    }
  })
  const seed = f.store.accept(input('seed'), f.root)
  f.store.finish(seed.runId, 'completed', 'Estado previo')
  f.store.session(input('seed').key, 'old-session', f.root)
  const accepted = await f.core.submit(input('next'))
  await until(() => finish)
  assert.equal(f.starts.length, 2)
  await f.core.submit(input('stop', 'stop'))
  await until(() => !f.core.active.size)
  const status = f.mcp.status('mcp:fixture', accepted.runId).run
  assert.equal(status.state, 'interrupted')
  assert.equal(status.failure, undefined)
  assert.match(status.error, /Detenido por el usuario/)
  assert.equal(f.messages.filter((message) => message.kind === 'finish').length, 1)
})

test('valid JSON with an internal MCP startup error is not called an invalid JSON stream', async (t) => {
  const script = `console.log(JSON.stringify({type:'system',subtype:'init',session_id:'fixture-session',mcp_servers:[{name:'regent',status:'failed'}]}));`
  const f = fixture(t, script)
  const { run } = await outcome(f)
  assert.match(run.error, /MCP interno de regent no arranco/)
  assert.doesNotMatch(run.error, /Stream de Claude invalido/)
})
