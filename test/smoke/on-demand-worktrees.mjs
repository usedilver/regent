import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { randomUUID, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { ConfigSchema } from '../../src/config.ts'
import { Core } from '../../src/core/core.ts'
import { Store } from '../../src/storage/store.ts'
import { createHttp } from '../../src/adapters/http.ts'
import { isolationFor } from '../../src/core/repository.ts'

if (process.env.REGENT_SMOKE !== '1') {
  console.error(
    'Opt-in: REGENT_SMOKE=1 node test/smoke/on-demand-worktrees.mjs. Uses the official CLI/operator auth and incurs normal provider usage.',
  )
  process.exit(1)
}
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-demand-smoke-'))),
  repo = path.join(root, 'repo')
const token = randomBytes(32).toString('hex'),
  marker = 'probe-' + randomBytes(5).toString('hex')
const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)),
  )
const close = (server) => new Promise((resolve) => server.close(resolve))
let calls = 0,
  sqlCalls = 0
const fixture = http.createServer(async (request, response) => {
  if (request.headers.authorization !== 'Bearer ' + token) {
    response.writeHead(401)
    response.end()
    return
  }
  const server = new McpServer({ name: 'demand-fixture', version: '1.0.0' })
  server.registerTool(
    'get_probe',
    { description: 'Read the root project probe marker.', annotations: { readOnlyHint: true } },
    async () => {
      calls++
      return { content: [{ type: 'text', text: marker }] }
    },
  )
  server.registerTool(
    'execute_sql',
    {
      description: 'Read synthetic fixture SQL rows. Only SELECT 1 is supported.',
      inputSchema: { query: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => {
      assert.match(query, /^select\s+1/i)
      sqlCalls++
      return { content: [{ type: 'text', text: 'fixture-row-1' }] }
    },
  )
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  response.on('close', () => {
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(request, response)
})
let core, internal, store
try {
  const address = await listen(fixture)
  fs.mkdirSync(repo)
  fs.mkdirSync(path.join(repo, '.claude/skills/probe'), { recursive: true })
  fs.writeFileSync(
    path.join(repo, '.claude/skills/probe/SKILL.md'),
    '---\nname: probe\ndescription: Investigate the probe fixture using its read-only MCP connection.\n---\nRead answer.txt and call demand-fixture get_probe plus execute_sql with SELECT 1. These are read-only fixture readers. Do not delegate.\n',
  )
  fs.writeFileSync(
    path.join(repo, 'CLAUDE.md'),
    'For fixture requests use the probe skill. No subagents, no commits, no tests, no extra files. Follow the core execution mode.\n',
  )
  fs.writeFileSync(path.join(repo, 'answer.txt'), 'original\n')
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n.claude/worktrees/\n')
  fs.writeFileSync(path.join(repo, '.env'), 'DEMAND_PROBE_TOKEN=' + token + '\n')
  fs.writeFileSync(
    path.join(repo, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        'demand-fixture': {
          type: 'http',
          url: address + '/mcp',
          headers: { Authorization: 'Bearer ${DEMAND_PROBE_TOKEN}' },
        },
      },
    }),
  )
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  git('init', '-b', 'main')
  git('add', '.')
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Fixture',
  )
  store = new Store(path.join(root, 'state.sqlite'))
  const config = ConfigSchema.parse({
    auth: { mode: 'indie' },
    repos: { path: root, default_repo: 'repo', readonly_mcp: ['demand-fixture'] },
    slack: { workspace_team_id: 'T1', allowed_users: ['U1'] },
    models: { ask: 'sonnet', patch: 'sonnet', task: 'sonnet', project: 'sonnet' },
    limits: {
      max_run_sec: { ask: 120, patch: 120, task: 120, project: 120 },
      stall_sec: 60,
      cancel_grace_sec: 2,
    },
  })
  core = new Core({
    store,
    config,
    cwd: root,
    output: { async notice() {}, async status() {}, async delta() {}, async finish() {} },
    runnerOverrides: { command: 'claude' },
  })
  // command uses the unmodified official binary, avoiding Regent's legacy settings
  // bootstrap. The harness never inspects/copies auth files; the official CLI uses
  // the operator's normal authentication and settings.
  internal = createHttp(core, () => ({}))
  core.toolsUrl = (await listen(internal)) + '/tools'
  const run = async (text) => {
    const accepted = await core.submit({
      adapter: 'slack',
      key: 'smoke',
      author: 'U1',
      team: 'T1',
      channel: 'C1',
      eventId: randomUUID(),
      text,
    })
    while (core.active.size)
      await Promise.all([...core.active.values()].map((active) => active.done))
    const result = store.run(accepted.runId)
    assert.equal(result.state, 'completed', result.error || result.result)
    return result
  }
  const first = await run(
    'Investiga answer.txt con la skill probe y el lector MCP get_probe. No cambies nada ni ejecutes comandos. Responde solo el contenido y el marcador.',
  )
  assert.match(first.result, /original/)
  if (!first.result.includes(marker)) {
    const init = store.db
      .prepare("SELECT data FROM events WHERE run_id=? AND kind='init'")
      .get(first.id)
    const data = init ? JSON.parse(init.data) : {}
    console.error(
      'Probe MCP state:',
      JSON.stringify(data.mcpServers?.filter((server) => /regent|demand/.test(server.name))),
    )
  }
  assert.ok(first.result.includes(marker), first.result)
  assert.ok(sqlCalls > 0, 'The query must use the read-only execute_sql wrapper')
  assert.ok(!fs.existsSync(path.join(repo, '.claude/worktrees')))
  const session = store.conversation('smoke').session_id
  console.log('PASS real query: root skill, env/MCP and no worktree')
  await run(
    'Cambia answer.txt para que contenga exactamente edited seguido de salto de línea. Usa Edit o Write. No hagas otros cambios ni commits. Conserva el contexto investigado y verifica el archivo.',
  )
  const isolated = isolationFor(repo, 'smoke').dir
  assert.equal(fs.readFileSync(path.join(isolated, 'answer.txt'), 'utf8'), 'edited\n')
  assert.equal(fs.readFileSync(path.join(repo, 'answer.txt'), 'utf8'), 'original\n')
  assert.notEqual(store.conversation('smoke').session_id, session)
  const editingSession = store.conversation('smoke').session_id
  console.log('PASS real promotion: fresh CLI session, isolated edit, original untouched')
  const third = await run(
    'Explica el contenido actual de answer.txt y consulta get_probe. No hagas cambios. Responde solo el contenido y el marcador.',
  )
  assert.match(third.result, /edited/)
  assert.ok(third.result.includes(marker))
  assert.equal(store.conversation('smoke').session_id, editingSession)
  assert.equal((git('worktree', 'list', '--porcelain').match(/^worktree /gm) ?? []).length, 2)
  assert.ok(calls >= 2)
  console.log(
    'PASS real query after edit: existing worktree/session reused, root MCP still available',
  )
} finally {
  await core?.close()
  if (internal) await close(internal)
  await close(fixture)
  store?.close()
  fs.rmSync(root, { recursive: true, force: true })
}
