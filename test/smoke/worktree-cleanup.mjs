import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Core } from '../../src/core/core.ts'
import { Store } from '../../src/storage/store.ts'
import { ConfigSchema } from '../../src/config.ts'
import { ExternalMcp } from '../../src/adapters/mcp/server.ts'
import { createHttp } from '../../src/adapters/http.ts'
import { isolationFor } from '../../src/core/repository.ts'

if (process.env.REGENT_SMOKE !== '1')
  throw new Error(
    'Opt-in: REGENT_SMOKE=1 node test/smoke/worktree-cleanup.mjs. Uses the official CLI/operator authentication and incurs normal provider usage.',
  )
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-cleanup-smoke-')))
const repo = path.join(root, 'repo')
const token = randomBytes(32).toString('hex')
const client = new Client({ name: 'cleanup-smoke', version: '1.0.0' })
let core, store, server
try {
  fs.mkdirSync(repo)
  const git = (cwd, ...args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
      { cwd, stdio: 'pipe', encoding: 'utf8' },
    ).trim()
  git(root, 'init', '--bare', path.join(root, 'remote.git'))
  git(repo, 'init', '-b', 'main')
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/worktrees/\n')
  fs.writeFileSync(
    path.join(repo, 'CLAUDE.md'),
    'Synthetic fixture. Do not delegate, change code, create commits or PRs, or inspect external services. The only requested operation will be conversation worktree cleanup through Regent. No Bash commands are necessary.\n',
  )
  fs.writeFileSync(path.join(repo, 'file.txt'), 'preserve source\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'Fixture')
  git(repo, 'remote', 'add', 'origin', path.join(root, 'remote.git'))
  git(repo, 'push', '-u', 'origin', 'main')
  store = new Store(path.join(root, 'state.sqlite'))
  const config = ConfigSchema.parse({
    auth: { mode: 'indie' },
    repos: { path: root, default_repo: 'repo' },
    slack: { workspace_team_id: 'T', allowed_users: [] },
    mcp: { enabled: true, principals: [{ id: 'fixture', token_env: 'REGENT_MCP_TOKEN_FIXTURE' }] },
    limits: {
      max_run_sec: { ask: 90, patch: 120, task: 120, project: 120 },
      stall_sec: 75,
      cancel_grace_sec: 5,
    },
  })
  core = new Core({
    store,
    config,
    cwd: root,
    runnerOverrides: { command: 'claude' },
    output: { async notice() {}, async status() {}, async delta() {}, async finish() {} },
  })
  const external = new ExternalMcp(core, { REGENT_MCP_TOKEN_FIXTURE: token })
  server = createHttp(core, () => ({}), external)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = `http://127.0.0.1:${server.address().port}`
  core.toolsUrl = address + '/tools'
  await client.connect(
    new StreamableHTTPClientTransport(new URL(address + '/mcp'), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  )
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 })
    assert.ok(!result.isError, JSON.stringify(result.content))
    return result.structuredContent ?? JSON.parse(result.content[0].text)
  }
  const wait = async (id) => {
    let result
    do {
      result = await call('regent_get_run', { run_id: id, wait_ms: 20000 })
    } while (['queued', 'running'].includes(result.latest_run.state))
    assert.equal(result.latest_run.state, 'completed', result.latest_run.result)
    return result.latest_run
  }
  const first = await call('regent_start', {
    request_id: randomUUID(),
    intent: 'task',
    prompt: 'El PR ya se mergeó. Solo confirma que entendiste, no limpies nada ni hagas cambios.',
  })
  await wait(first.run_id)
  const isolated = isolationFor(repo, first.conversation_id).dir
  assert.ok(fs.existsSync(isolated), 'merge alone must not remove the worktree')
  const second = await call('regent_continue', {
    conversation_id: first.conversation_id,
    request_id: randomUUID(),
    intent: 'task',
    prompt: 'Ya hice merge. Elimina el worktree de esta conversación.',
  })
  const result = await wait(second.run_id)
  console.log(
    JSON.stringify({ state: result.state, cleanup: result.cleanup, cost_usd: result.cost_usd }),
  )
  assert.equal(result.cleanup?.state, 'removed', result.result)
  assert.ok(!fs.existsSync(isolated))
  assert.equal(store.conversation(first.conversation_id).session_id, null)
  assert.equal(fs.readFileSync(path.join(repo, 'file.txt'), 'utf8'), 'preserve source\n')
  assert.ok(!git(repo, 'worktree', 'list', '--porcelain').includes(isolated))
  console.log(
    'PASS real CLI + MCP: merge alone preserved the worktree; explicit cleanup removed it after executor exit, preserved source/history and detached the session.',
  )
} finally {
  await core?.close()
  await client.close().catch(() => {})
  if (server) await new Promise((resolve) => server.close(resolve))
  store?.close()
  fs.rmSync(root, { recursive: true, force: true })
}
