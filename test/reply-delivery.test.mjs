import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Core } from '../src/core/core.ts'
import { ConfigSchema } from '../src/config.ts'
import { Store } from '../src/storage/store.ts'
import { DurableOutput } from '../src/storage/delivery.ts'
import { SlackOutput } from '../src/adapters/slack/output.ts'
import { createHttp } from '../src/adapters/http.ts'
import { replyPayloads } from '../src/adapters/slack/format.ts'
import { checkReply } from '../plugins/executor/hooks/reply.mjs'

const report = '# Resultado\n\nInforme completo en español.'
const narration = "I'll investigate this now."
const acknowledgement = 'Análisis entregado.'
const input = {
  adapter: 'slack',
  eventId: 'request',
  key: 'slack:C:1',
  channel: 'C',
  thread: '1',
  author: 'U',
  team: 'T',
  text: 'Revisa el proyecto',
}

async function until(predicate) {
  const end = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Reply test timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function fixture(t, { text = report, missing = false, cleanup = false, api } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-prepared-reply-')))
  const database = path.join(root, 'test.sqlite')
  const store = new Store(database)
  const posts = []
  const slack = new SlackOutput(
    api ??
      (async (method, args) => {
        if (method === 'chat.postMessage') posts.push(args)
        return { ts: `receipt-${posts.length}` }
      }),
  )
  slack.store = store
  const output = new DurableOutput(store, slack)
  const script = `const emit=x=>console.log(JSON.stringify(x));
const config=JSON.parse(process.argv[process.argv.indexOf('--mcp-config')+1]).mcpServers.regent;
async function call(name,args){const response=await fetch(config.url,{method:'POST',headers:{...config.headers,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});const body=await response.json();if(body.error||body.result?.isError)throw new Error(JSON.stringify(body));}
emit({type:'system',subtype:'init',session_id:'fixture',mcp_servers:[],tools:['mcp__regent__regent_reply']});
emit({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:${JSON.stringify(narration)}}}});
emit({type:'assistant',message:{id:'progress',content:[{type:'text',text:'Listo, limpié el servidor.'}]}});
${cleanup ? "await call('regent_cleanup_worktree',{}); const policy=await fetch(config.url.replace(/\\/tools$/,'/tool-policy'),{method:'POST',headers:{...config.headers,'content-type':'application/json'},body:JSON.stringify({tool_name:'mcp__regent__regent_reply',tool_input:{text:'verified'}})}); if((await policy.json()).reason)throw new Error('Reply refused after cleanup');" : ''}
${missing ? '' : `await call('regent_reply',{text:${JSON.stringify(text)}});`}
emit({type:'assistant',message:{content:[{type:'tool_use',name:'Edit',id:'memory',input:{}}]}});
emit({type:'result',result:${JSON.stringify(acknowledgement)},total_cost_usd:0});`
  const core = new Core({
    store,
    output,
    cwd: root,
    config: ConfigSchema.parse({
      auth: { mode: 'indie' },
      repos: { path: root },
      slack: { workspace_team_id: 'T', allowed_users: ['U'] },
    }),
    runnerOverrides: {
      command: process.execPath,
      prefixArgs: ['--input-type=module', '-e', script, '--'],
      stallMs: 2000,
    },
  })
  const server = createHttp(core, () => ({}))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  core.toolsUrl = `http://127.0.0.1:${server.address().port}/tools`
  t.after(async () => {
    await core.close()
    await output.close()
    await new Promise((resolve) => server.close(resolve))
    store.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, database, core, store, output, slack, posts }
}

async function run(f) {
  const accepted = await f.core.submit(input)
  await until(() => !f.core.active.size)
  await f.output.flush()
  return f.store.run(accepted.runId)
}

test('a saved report survives a later tool and short closing; English narration stays private', async (t) => {
  const f = await fixture(t)
  const result = await run(f)
  assert.equal(result.state, 'completed', result.error)
  assert.equal(result.result, report)
  assert.equal(f.posts.map((post) => post.text).join(''), report)
  assert.equal(f.store.preparedReply(result.id), report)
  assert.doesNotMatch(JSON.stringify(f.posts), /investigate|limpié|Análisis entregado/)
})

test('missing prepared reply fails visibly instead of delivering an acknowledgement', async (t) => {
  const f = await fixture(t, { missing: true })
  const result = await run(f)
  assert.equal(result.state, 'failed')
  assert.match(result.error, /sin preparar/)
  assert.match(f.posts[0].text, /incompleto/)
  assert.doesNotMatch(JSON.stringify(f.posts), /investigate|limpié|Análisis entregado/)
})

test('the verified cleanup result cannot be contradicted by discarded intermediate prose', async (t) => {
  const f = await fixture(t, { cleanup: true })
  f.core.cleanupWorktree = async () => ({
    state: 'blocked',
    message: 'No eliminé el worktree: hay trabajo sin respaldo.',
  })
  const result = await run(f)
  assert.equal(result.result, `No eliminé el worktree: hay trabajo sin respaldo.\n\n${report}`)
  assert.doesNotMatch(JSON.stringify(f.posts), /limpié el servidor/)
})

test('prepared replies replace earlier drafts and survive reopening SQLite', async (t) => {
  const f = await fixture(t)
  const result = await run(f)
  f.store.prepareReply(result.id, 'Versión corregida')
  const reader = new Store(f.database)
  try {
    assert.equal(reader.preparedReply(result.id), 'Versión corregida')
  } finally {
    reader.close()
  }
})

test('a cleanup-only reply may be empty; runtime supplies the verified result', async (t) => {
  const f = await fixture(t, { cleanup: true, text: '' })
  f.core.cleanupWorktree = async () => ({ state: 'removed', message: 'Eliminé el worktree.' })
  const result = await run(f)
  assert.equal(result.result, 'Eliminé el worktree.')
  assert.equal(f.store.preparedReply(result.id), '')
})

test('Stop requests consolidation until the complete reply is saved, and permits required waits', async (t) => {
  const f = await fixture(t)
  let finish
  let background = false
  f.core.runner = (options) => ({
    done: new Promise((resolve) => {
      finish = resolve
    }),
    cancel() {
      finish({ state: 'interrupted', text: '', error: 'stopped', cost: 0, usage: {} })
    },
    hasBackgroundTasks: () => background,
  })
  const accepted = await f.core.submit(input)
  await until(() => f.core.active.get(input.key)?.controller)
  const active = f.core.active.get(input.key)
  assert.equal(f.core.completionDecision(active.token).decision, 'block')
  assert.equal(
    f.core.completionDecision(active.token, [{ id: 'background', is_ambient: false }]).decision,
    'allow',
  )
  const blocked = await checkReply({ hook_event_name: 'Stop' }, f.core.toolsUrl, active.token)
  assert.match(blocked.reason, /complete user-facing result/)
  background = true
  assert.equal(f.core.completionDecision(active.token).decision, 'allow')
  await assert.rejects(
    f.core.tool(active.token, 'regent_reply', { text: report }),
    /trabajo de fondo/,
  )
  background = false
  active.waiting = true
  assert.equal(f.core.completionDecision(active.token).decision, 'allow')
  active.waiting = false
  await f.core.tool(active.token, 'regent_reply', { text: report })
  assert.equal(await checkReply({ hook_event_name: 'Stop' }, f.core.toolsUrl, active.token), null)
  finish({ state: 'completed', text: acknowledgement, error: '', cost: 0, usage: {} })
  await until(() => !f.core.active.size)
  assert.equal(f.store.run(accepted.runId).result, report)
})

test('the full saved reply survives paginated delivery failure and a delegate restart', async (t) => {
  const longReport = report + '\n\n' + 'Hallazgo verificable. '.repeat(800)
  const secret = 'sk-ant-synthetic-reply-secret'
  const posts = []
  let offline = true
  const api = async (method, args) => {
    if (method !== 'chat.postMessage') return {}
    if (offline && posts.length === 1) throw new Error('synthetic network failure')
    posts.push(args)
    return { ts: `receipt-${posts.length}` }
  }
  const f = await fixture(t, { text: `${longReport}\n${secret}`, api })
  const result = await run(f)
  assert.equal(result.state, 'completed')
  assert.ok(result.result.includes(longReport))
  assert.ok(!result.result.includes(secret))
  assert.ok(f.store.preparedReply(result.id).includes('[REDACTED]'))
  assert.equal(posts.length, 1)
  assert.equal(
    f.store.db.prepare("SELECT state FROM deliveries WHERE kind='finish'").get().state,
    'pending',
  )
  const resumed = new SlackOutput(api)
  resumed.store = f.store
  const recovered = new DurableOutput(f.store, resumed)
  offline = false
  await recovered.flush()
  await recovered.close()
  assert.deepEqual(
    posts.map((post) => post.text),
    replyPayloads(result.result).map((page) => page.text),
  )
  assert.ok(posts.every((post) => post.channel === 'C' && post.thread_ts === '1'))
})
