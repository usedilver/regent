import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ConfigSchema } from '../../src/config.ts'
import { Core } from '../../src/core/core.ts'
import { Store } from '../../src/storage/store.ts'
import { createHttp } from '../../src/adapters/http.ts'
import { isolationFor } from '../../src/core/repository.ts'

if (process.env.REGENT_SMOKE !== '1') {
  console.error(
    'Opt-in: REGENT_SMOKE=1 node test/smoke/project-smoke.mjs. Uses real Claude Code and may incur usage charges.',
  )
  process.exit(1)
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-project-smoke-')))
const project = path.join(root, 'project'),
  seed = path.join(root, 'seed')
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const commit = (cwd) => {
  git(cwd, 'add', '.')
  git(
    cwd,
    '-c',
    'user.name=Smoke',
    '-c',
    'user.email=smoke@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'Fixture',
  )
}
const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)),
  )
const close = (server) => new Promise((resolve) => server.close(resolve))
const token = randomBytes(32).toString('hex')
let verifiedCalls = 0,
  core,
  internal
const fixture = http.createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401)
    response.end()
    return
  }
  const server = new McpServer({ name: 'project-fixture', version: '1.0.0' })
  server.registerTool(
    'get_project_marker',
    {
      description: 'Read the root project connection marker.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      verifiedCalls++
      return { content: [{ type: 'text', text: 'fixture-root-connection-ok' }] }
    },
  )
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  response.on('close', () => {
    void server.close()
  })
  try {
    await server.connect(transport)
    await transport.handleRequest(request, response)
  } catch {
    if (!response.headersSent) response.writeHead(500)
    response.end()
  }
})

try {
  const fixtureUrl = await listen(fixture)
  git(root, 'init', '-b', 'main', seed)
  fs.writeFileSync(path.join(seed, 'answer.txt'), 'before\n')
  commit(seed)
  git(root, 'init', '-b', 'main', project)
  for (const service of ['backend', 'frontend']) {
    git(project, '-c', 'protocol.file.allow=always', 'submodule', 'add', seed, service)
    git(project, 'config', '-f', '.gitmodules', `submodule.${service}.ignore`, 'all')
  }
  fs.writeFileSync(path.join(project, '.gitignore'), '.env\n.claude/worktrees/\n')
  fs.writeFileSync(path.join(project, '.env'), `PROJECT_SMOKE_TOKEN=${token}\n`)
  fs.writeFileSync(
    path.join(project, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        'project-fixture': {
          type: 'http',
          url: `${fixtureUrl}/mcp`,
          headers: { Authorization: 'Bearer ${PROJECT_SMOKE_TOKEN}' },
        },
      },
    }),
  )
  fs.writeFileSync(
    path.join(project, 'AGENTS.md'),
    'This is a temporary project fixture. Invoke shared-check before changing either service. Keep the project session; do not switch repositories.\n',
  )
  fs.symlinkSync('AGENTS.md', path.join(project, 'CLAUDE.md'))
  fs.mkdirSync(path.join(project, '.claude/skills/shared-check'), { recursive: true })
  fs.writeFileSync(
    path.join(project, '.claude/skills/shared-check/SKILL.md'),
    `---
name: shared-check
description: Verify the shared root context when editing the backend or frontend fixture services.
---
Call the project-fixture MCP tool get_project_marker and verify fixture-root-connection-ok.
Then follow the user's requested edits inside the current project's isolated services.
`,
  )
  commit(project)
  const store = new Store(':memory:')
  const config = ConfigSchema.parse({
    auth: { mode: 'indie' },
    repos: { path: root, default_repo: 'project' },
    slack: { workspace_team_id: 'SMOKE', allowed_users: ['SMOKE'] },
    limits: { max_run_sec: { task: 300 }, stall_sec: 120, cancel_grace_sec: 5 },
  })
  core = new Core({
    store,
    config,
    cwd: root,
    output: { async notice() {}, async status() {}, async delta() {}, async finish() {} },
  })
  internal = createHttp(core, () => ({}))
  core.toolsUrl = `${await listen(internal)}/tools`
  const accepted = await core.submit({
    adapter: 'cli',
    key: 'project-smoke',
    eventId: 'project-smoke',
    channel: 'project-smoke',
    author: 'SMOKE',
    intent: 'task',
    text: 'Invoke the shared-check skill from the project root and call its project-fixture get_project_marker MCP tool. After confirming the marker, write exactly "updated\\n" to backend/answer.txt and frontend/answer.txt inside this conversation worktree. Use the same session for both services. Do not call regent_use_repo, commit, push, create a PR, edit source checkouts or print environment values. Report the two file paths and marker briefly.',
  })
  while (core.active.size) await new Promise((resolve) => setTimeout(resolve, 100))
  const run = store.run(accepted.runId)
  assert.equal(run.state, 'completed', run.error)
  const events = store.db.prepare('SELECT kind,data FROM events WHERE run_id=?').all(run.id)
  const tools = events
    .filter((event) => event.kind === 'tool_use')
    .map((event) => JSON.parse(event.data))
  assert.ok(
    tools.some((tool) => tool.name === 'Skill' && tool.input?.skill?.includes('shared-check')),
    'Shared root skill was not invoked',
  )
  assert.ok(verifiedCalls > 0, 'Root MCP did not authenticate using the root environment')
  assert.equal(
    events.filter((event) => event.kind === 'init').length,
    1,
    'Expected one Claude session',
  )
  assert.ok(
    !tools.some((tool) => tool.name.includes('regent_use_repo')),
    'Unexpected project handoff',
  )
  const isolated = isolationFor(project, 'project-smoke')
  for (const service of ['backend', 'frontend']) {
    assert.equal(
      fs.readFileSync(path.join(isolated.dir, service, 'answer.txt'), 'utf8'),
      'updated\n',
    )
    assert.equal(fs.readFileSync(path.join(project, service, 'answer.txt'), 'utf8'), 'before\n')
  }
  console.log(
    'OK real Claude Code: root skill + authenticated root MCP + two isolated submodule edits in one session; source checkouts unchanged.',
  )
} finally {
  if (core) {
    await core.close()
    core.store.close()
  }
  if (internal?.listening) await close(internal)
  if (fixture.listening) await close(fixture)
  if (process.env.REGENT_SMOKE_KEEP === '1') console.log(`Fixture retained: ${root}`)
  else fs.rmSync(root, { recursive: true, force: true })
}
