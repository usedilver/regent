import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ConfigSchema } from '../src/config.ts'
import { Core } from '../src/core/core.ts'
import { Store } from '../src/storage/store.ts'
import { createHttp } from '../src/adapters/http.ts'
import { ExternalMcp } from '../src/adapters/mcp/server.ts'
import { mcpOutput, routeMcpOutput } from '../src/adapters/mcp/output.ts'
import { startRunner } from '../src/execution/runner.ts'
import { isolationFor } from '../src/core/repository.ts'

let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  OK ${name}`)
  } catch (error) {
    failed++
    console.error(`  FAIL ${name}: ${error.stack}`)
  }
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'regent-mcp-'))
const fake = path.resolve('test/fixtures/fake-claude.mjs')
const tokens = { REGENT_MCP_TOKEN_ALICE: 'a'.repeat(48), REGENT_MCP_TOKEN_BOB: 'b'.repeat(48) }
const baseConfig = () =>
  ConfigSchema.parse({
    auth: { mode: 'indie' },
    repos: { path: root },
    slack: { workspace_team_id: 'T1', allowed_users: ['U1'] },
    mcp: {
      enabled: true,
      principals: [
        { id: 'alice', token_env: 'REGENT_MCP_TOKEN_ALICE' },
        { id: 'bob', token_env: 'REGENT_MCP_TOKEN_BOB' },
      ],
    },
    limits: { cancel_grace_sec: 0.05 },
  })
const until = async (predicate) => {
  const deadline = Date.now() + 6000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('wait timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
async function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'fixture-'))
  const repo = path.join(dir, 'dashboard')
  fs.mkdirSync(repo)
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', [
    '-C',
    repo,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture',
  ])
  const store = new Store(options.file ?? ':memory:')
  const messages = [],
    starts = [],
    clients = []
  const slack = Object.fromEntries(
    ['notice', 'status', 'delta', 'finish', 'question', 'progress', 'activity'].map((kind) => [
      kind,
      async (...args) => {
        messages.push({ kind, args })
      },
    ]),
  )
  const config = baseConfig()
  if (options.name) config.name = options.name
  config.repos.path = dir
  config.repos.default_repo = 'dashboard'
  config.limits.max_concurrent_runs = options.concurrency ?? 3
  const state = { scenario: 'success' }
  const core = new Core({
    store,
    config,
    cwd: dir,
    output: routeMcpOutput(slack, mcpOutput(store)),
    adapter: ['slack', 'mcp'],
    runner: (args) => {
      starts.push(args)
      if (args.worktreeName) {
        const directory = path.join(args.cwd, '.claude/worktrees', args.worktreeName)
        if (!fs.existsSync(path.join(directory, '.git')))
          execFileSync('git', ['-C', args.cwd, 'worktree', 'add', '--detach', directory, 'HEAD'], {
            stdio: 'ignore',
          })
      }
      return startRunner({
        ...args,
        command: process.execPath,
        prefixArgs: [fake],
        env: { ...args.env, FAKE_CLAUDE_SCENARIO: state.scenario },
      })
    },
  })
  const gateway = new ExternalMcp(core, tokens)
  const server = createHttp(core, () => ({ fixture: true }), gateway)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  core.toolsUrl = `${url}/tools`
  return {
    core,
    store,
    messages,
    starts,
    state,
    gateway,
    url,
    repo,
    dir,
    async client(token = tokens.REGENT_MCP_TOKEN_ALICE) {
      const client = new Client({ name: 'fixture', version: '1' })
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      )
      clients.push(client)
      return client
    },
    async close() {
      await Promise.allSettled(clients.map((client) => client.close()))
      await core.close()
      await new Promise((resolve) => server.close(resolve))
      store.close()
    },
  }
}
const call = async (client, name, args) => {
  const response = await client.callTool({
    name,
    arguments: name === 'regent_get_run' ? { wait_ms: 0, ...args } : args,
  })
  assert.ok(!response.isError, response.content[0].text)
  return JSON.parse(response.content[0].text)
}
const start = (client, extra = {}) =>
  call(client, 'regent_start', {
    request_id: randomUUID(),
    repo: 'dashboard',
    prompt: 'Crea un grafico de ofertas y comprueba el cambio.',
    ...extra,
  })

try {
  await check(
    'MCP is opt-in and refuses missing, short, duplicate or reserved transport credentials',
    async () => {
      const config = baseConfig()
      const store = new Store(':memory:')
      const core = new Core({ store, config, output: mcpOutput(store), cwd: root })
      try {
        assert.throws(() => new ExternalMcp(core, {}), /al menos 32/)
        assert.throws(
          () => new ExternalMcp(core, { ...tokens, REGENT_MCP_TOKEN_ALICE: 'short' }),
          /al menos 32/,
        )
        assert.throws(
          () =>
            new ExternalMcp(core, {
              ...tokens,
              REGENT_MCP_TOKEN_BOB: tokens.REGENT_MCP_TOKEN_ALICE,
            }),
          /unicos/,
        )
        config.mcp.principals.push(config.mcp.principals[0])
        assert.throws(() => new ExternalMcp(core, tokens), /unicos/)
        assert.throws(() =>
          ConfigSchema.parse({
            ...config,
            mcp: { enabled: true, principals: [{ id: 'x', token_env: 'ANTHROPIC_API_KEY' }] },
          }),
        )
        config.mcp = { enabled: false, principals: [] }
        assert.equal(core.authorized({ adapter: 'mcp', author: 'mcp:alice' }), false)
        const server = createHttp(core, () => ({}))
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
        try {
          assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/mcp`)).status, 404)
        } finally {
          await new Promise((resolve) => server.close(resolve))
        }
      } finally {
        store.close()
      }
    },
  )
  await check(
    'external HTTP auth is separate from run auth; malformed, browser and oversized requests fail closed',
    async () => {
      const f = await fixture()
      try {
        for (const token of ['', 'wrong'])
          assert.equal(
            (await fetch(`${f.url}/mcp`, { headers: { Authorization: `Bearer ${token}` } })).status,
            401,
          )
        const headers = {
          Authorization: `Bearer ${tokens.REGENT_MCP_TOKEN_ALICE}`,
          'content-type': 'application/json',
        }
        assert.equal(
          (await fetch(`${f.url}/tools`, { method: 'POST', headers, body: '{}' })).status,
          401,
        )
        assert.equal((await fetch(`${f.url}/mcp`, { headers })).status, 405)
        assert.equal(
          (
            await fetch(`${f.url}/mcp`, {
              method: 'POST',
              headers: { ...headers, Origin: 'https://attacker.invalid' },
              body: '{}',
            })
          ).status,
          403,
        )
        assert.equal(
          (await fetch(`${f.url}/mcp`, { method: 'POST', headers, body: 'invalid' })).status,
          400,
        )
        assert.equal(
          (
            await fetch(`${f.url}/mcp`, {
              method: 'POST',
              headers,
              body: 'x'.repeat(1024 * 1024 + 1),
            })
          ).status,
          413,
        )
        assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM runs').get().n, 0)
      } finally {
        await f.close()
      }
    },
  )
  await check(
    'tools start once under retries, preserve attribution and never send MCP results to Slack',
    async () => {
      const f = await fixture()
      try {
        const client = await f.client()
        assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
          'regent_cancel',
          'regent_context',
          'regent_continue',
          'regent_get_run',
          'regent_show_progress',
          'regent_start',
        ])
        assert.match(client.getInstructions(), /regent_context/)
        assert.match(
          (await client.listTools()).tools.find((tool) => tool.name === 'regent_start').description,
          /Repositorio predeterminado: dashboard\./,
        )
        const request_id = randomUUID()
        const [one, retry] = await Promise.all([
          start(client, { request_id }),
          start(client, { request_id }),
        ])
        assert.equal(one.run_id, retry.run_id)
        assert.equal(Number(one.duplicate) + Number(retry.duplicate), 1)
        await until(() => !f.core.active.size)
        const status = await call(client, 'regent_get_run', { run_id: one.run_id })
        assert.equal(status.run.state, 'completed')
        assert.match(status.run.result, /Crea un grafico/)
        assert.equal(status.repo, fs.realpathSync(f.repo))
        assert.equal(f.store.run(one.run_id).author, 'mcp:alice')
        assert.equal(f.starts.length, 1)
        assert.match(f.starts[0].worktreeName, /^regent-/)
        assert.deepEqual(f.messages, [])
        assert.equal(f.core.authorized({ adapter: 'mcp', author: 'U1', team: 'T1' }), false)
      } finally {
        await f.close()
      }
    },
  )
  await check(
    'context discovers independent repo skills without inheriting unrelated parent MCPs; start uses the default repo',
    async () => {
      const f = await fixture()
      try {
        fs.writeFileSync(path.join(f.dir, 'AGENTS.md'), 'Parent workspace guidance')
        fs.writeFileSync(
          path.join(f.dir, '.mcp.json'),
          JSON.stringify({
            mcpServers: {
              'database-prod': { command: 'fixture', env: { TOKEN: 'private-fixture-token' } },
            },
          }),
        )
        fs.writeFileSync(path.join(f.repo, 'AGENTS.md'), 'Nested dashboard guidance')
        fs.symlinkSync('AGENTS.md', path.join(f.repo, 'CLAUDE.md'))
        fs.mkdirSync(path.join(f.repo, '.agents/skills/new-dashboard'), { recursive: true })
        fs.writeFileSync(
          path.join(f.repo, '.agents/skills/new-dashboard/SKILL.md'),
          'Repository-owned skill',
        )
        fs.mkdirSync(path.join(f.repo, '.claude/skills'), { recursive: true })
        fs.symlinkSync(
          '../../.agents/skills/new-dashboard',
          path.join(f.repo, '.claude/skills/new-dashboard'),
        )
        fs.mkdirSync(path.join(f.repo, '.claude/agents'), { recursive: true })
        fs.writeFileSync(
          path.join(f.repo, '.claude/agents/chart-reviewer.md'),
          'Repository-owned agent',
        )
        const client = await f.client()
        const context = await call(client, 'regent_context', {})
        assert.equal(context.default_repo, 'dashboard')
        assert.equal(context.inventory_only, true)
        assert.equal(context.project_root, fs.realpathSync(f.repo))
        assert.deepEqual(
          context.instruction_directories.map((entry) => entry.directory),
          ['dashboard'],
        )
        assert.deepEqual(context.instruction_directories[0].configured_mcp_servers, [])
        assert.deepEqual(context.instruction_directories[0].skills, [
          { name: 'new-dashboard', path: 'dashboard/.claude/skills/new-dashboard/SKILL.md' },
        ])
        assert.equal(context.instruction_directories[0].agents[0].name, 'chart-reviewer')
        assert.doesNotMatch(JSON.stringify(context), /private-fixture-token/)
        assert.equal(f.starts.length, 0)
        const rejected = await client.callTool({ name: 'regent_context', arguments: { repo: '/' } })
        assert.equal(rejected.isError, true)
        const work = await call(client, 'regent_start', {
          request_id: randomUUID(),
          prompt: 'Modifica el grafico existente.',
        })
        await until(() => !f.core.active.size)
        assert.equal(f.store.conversation(work.conversation_id).cwd, fs.realpathSync(f.repo))
      } finally {
        await f.close()
      }
    },
  )
  await check(
    'principals cannot read, resume or cancel other conversations; repos cannot escape the workspace',
    async () => {
      const f = await fixture()
      try {
        const alice = await f.client(),
          bob = await f.client(tokens.REGENT_MCP_TOKEN_BOB)
        const work = await start(alice)
        for (const [name, args] of [
          ['regent_get_run', { run_id: work.run_id }],
          [
            'regent_continue',
            {
              conversation_id: work.conversation_id,
              request_id: randomUUID(),
              prompt: 'Cambia el grafico',
            },
          ],
          ['regent_cancel', { conversation_id: work.conversation_id }],
          ['regent_start', { request_id: randomUUID(), repo: '/', prompt: 'Modificar' }],
        ])
          assert.equal((await bob.callTool({ name, arguments: args })).isError, true)
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'regent-outside-'))
        try {
          fs.mkdirSync(path.join(outside, '.git'))
          fs.symlinkSync(outside, path.join(f.dir, 'escape'))
          assert.equal(
            (
              await alice.callTool({
                name: 'regent_start',
                arguments: { request_id: randomUUID(), repo: 'escape', prompt: 'Modificar' },
              })
            ).isError,
            true,
          )
        } finally {
          fs.rmSync(outside, { recursive: true, force: true })
        }
      } finally {
        await f.close()
      }
    },
  )
  await check(
    'MCP progress exposes real activity transitions, survives reopen and omits raw tool data',
    async () => {
      const f = await fixture({ file: path.join(root, 'activity.sqlite') })
      try {
        const client = await f.client()
        const work = await start(client)
        await until(() => !f.core.active.size)
        f.store.db.prepare("UPDATE runs SET state='running' WHERE id=?").run(work.run_id)
        f.store.event(work.run_id, 'tool_use', {
          id: 'z',
          kind: 'tool_use',
          name: 'Read',
          input: { file_path: 'private-fixture-secret' },
        })
        f.store.event(work.run_id, 'tool_result', {
          id: 'z',
          kind: 'tool_result',
          content: 'private-candidate-record',
        })
        f.store.event(work.run_id, 'tool_use', {
          id: 'a',
          kind: 'tool_use',
          name: 'Bash',
          input: { command: 'pnpm test', ignored: 'private-fixture-secret' },
        })
        const running = await call(client, 'regent_get_run', { run_id: work.run_id })
        assert.equal(running.activities.tasks.find((t) => t.id === 'read').status, 'complete')
        assert.equal(running.activities.tasks.find((t) => t.id === 'command').status, 'in_progress')
        assert.match(
          running.activities.tasks.find((t) => t.id === 'command').title,
          /Ejecutando pruebas/,
        )
        assert.doesNotMatch(
          JSON.stringify(running.activities),
          /private-fixture-secret|private-candidate-record/,
        )
        f.store.event(work.run_id, 'tool_result', { id: 'a', kind: 'tool_result', error: true })
        f.store.db.prepare("UPDATE runs SET state='failed' WHERE id=?").run(work.run_id)
        const reopened = new Store(path.join(root, 'activity.sqlite'))
        try {
          const progress = new ExternalMcp(
            {
              ...f.core,
              store: reopened,
              config: f.core.config,
              cwd: f.core.cwd,
              defaultCwd: f.core.defaultCwd,
            },
            tokens,
          ).status('mcp:alice', work.run_id)
          assert.equal(progress.activities.tasks.find((t) => t.id === 'command').status, 'error')
          assert.equal(progress.activities.title, 'Turno detenido')
        } finally {
          reopened.close()
        }
        const bob = await f.client(tokens.REGENT_MCP_TOKEN_BOB)
        assert.equal(
          (await bob.callTool({ name: 'regent_get_run', arguments: { run_id: work.run_id } }))
            .isError,
          true,
        )
        const tools = (await client.listTools()).tools
        for (const name of [
          'regent_context',
          'regent_start',
          'regent_continue',
          'regent_get_run',
        ]) {
          assert.equal(tools.find((t) => t.name === name)._meta?.ui?.resourceUri, undefined)
        }
        assert.equal(
          tools.find((t) => t.name === 'regent_show_progress')._meta.ui.resourceUri,
          'ui://regent/progress.html',
        )
        const panel = await call(client, 'regent_show_progress', { run_id: work.run_id })
        assert.equal(panel.latest_run.state, 'failed')
        assert.equal((await client.listResources()).resources[0].uri, 'ui://regent/progress.html')
        const resource = await client.readResource({ uri: 'ui://regent/progress.html' })
        assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app')
        assert.match(resource.contents[0].text, /regent_get_run/)
        assert.deepEqual(resource.contents[0]._meta.ui.csp.connectDomains, [])
      } finally {
        await f.close()
      }
    },
  )
  await check(
    'plain status waits for completion, bounds polling and aborts without cancelling the job',
    async () => {
      const f = await fixture()
      try {
        f.state.scenario = 'hang'
        const client = await f.client()
        const work = await start(client, {
          intent: 'ask',
          prompt: 'Answer a short read-only question.',
        })
        await until(() => Boolean(f.store.conversation(work.conversation_id).session_id))
        const before = Date.now()
        const running = await call(client, 'regent_get_run', { run_id: work.run_id, wait_ms: 80 })
        assert.ok(Date.now() - before >= 60)
        assert.equal(running.latest_run.state, 'running')
        const invalid = await client.callTool({
          name: 'regent_get_run',
          arguments: { run_id: work.run_id, wait_ms: 20001 },
        })
        assert.equal(invalid.isError, true)
        let finished = false
        const waiting = client
          .callTool({ name: 'regent_get_run', arguments: { run_id: work.run_id } })
          .then((result) => {
            finished = true
            return result
          })
        await new Promise((resolve) => setTimeout(resolve, 50))
        assert.equal(finished, false)
        const controller = new AbortController()
        const cancelled = client.callTool(
          { name: 'regent_get_run', arguments: { run_id: work.run_id } },
          undefined,
          { signal: controller.signal },
        )
        const rejected = assert.rejects(cancelled)
        controller.abort()
        await rejected
        assert.equal(f.store.run(work.run_id).state, 'running')
        await call(client, 'regent_cancel', { conversation_id: work.conversation_id })
        const result = await waiting
        assert.equal(result.isError, undefined)
        assert.equal(JSON.parse(result.content[0].text).latest_run.state, 'interrupted')
        assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM runs').get().n, 1)
        const immediate = Date.now()
        await client.callTool({ name: 'regent_get_run', arguments: { run_id: work.run_id } })
        assert.ok(Date.now() - immediate < 1000)
      } finally {
        await f.close()
      }
    },
  )
  await check(
    'MCP query-to-edit promotion keeps its conversation and later queries reuse that worktree',
    async () => {
      const f = await fixture()
      try {
        const client = await f.client()
        const work = await start(client, { prompt: 'Explica el repositorio sin hacer cambios' })
        await until(() => !f.core.active.size)
        assert.equal(f.starts[0].readOnly, true)
        assert.equal(f.starts[0].worktreeName, undefined)
        assert.ok(!fs.existsSync(path.join(f.repo, '.claude/worktrees')))
        const querySession = f.store.conversation(work.conversation_id).session_id
        await call(client, 'regent_continue', {
          conversation_id: work.conversation_id,
          request_id: randomUUID(),
          prompt: 'Implementa el cambio en el código',
        })
        await until(() => !f.core.active.size)
        assert.equal(f.starts[1].readOnly, false)
        assert.equal(f.starts[1].sessionId, null)
        assert.match(f.starts[1].prompt, /Prior conversation handoff/)
        const editingSession = f.store.conversation(work.conversation_id).session_id
        assert.notEqual(editingSession, querySession)
        await call(client, 'regent_continue', {
          conversation_id: work.conversation_id,
          request_id: randomUUID(),
          prompt: 'Explica lo que cambiaste',
        })
        await until(() => !f.core.active.size)
        assert.equal(f.starts[2].readOnly, true)
        assert.equal(f.starts[2].worktreeName, f.starts[1].worktreeName)
        assert.equal(f.starts[2].sessionId, editingSession)
      } finally {
        await f.close()
      }
    },
  )
  await check(
    'continuation answers questions and reuses the session/worktree without Slack identity lookups',
    async () => {
      const f = await fixture()
      try {
        f.state.scenario = 'hang'
        f.core.identities = () => {
          throw new Error('MCP must not use Slack profiles')
        }
        const client = await f.client()
        const work = await start(client)
        await until(() => Boolean(f.store.conversation(work.conversation_id).session_id))
        const session = f.store.conversation(work.conversation_id).session_id
        const active = f.core.active.get(work.conversation_id)
        const headers = { Authorization: `Bearer ${active.token}` }
        assert.equal((await fetch(`${f.url}/mcp`, { headers })).status, 401)
        await f.core.tool(active.token, 'regent_ask_human', {
          question: 'Por semana o mes?',
          options: ['Semana', 'Mes'],
        })
        await until(() => !f.core.active.size)
        const waiting = await call(client, 'regent_get_run', { run_id: work.run_id })
        assert.equal(waiting.run.state, 'waiting_human')
        assert.deepEqual(waiting.question, {
          text: 'Por semana o mes?',
          options: ['Semana', 'Mes'],
        })
        f.state.scenario = 'success'
        const request_id = randomUUID()
        const continued = await call(client, 'regent_continue', {
          conversation_id: work.conversation_id,
          request_id,
          prompt: 'Por semana',
        })
        const retry = await call(client, 'regent_continue', {
          conversation_id: work.conversation_id,
          request_id,
          prompt: 'Por semana',
        })
        assert.equal(continued.run_id, retry.run_id)
        await until(() => !f.core.active.size)
        assert.equal(f.starts[1].sessionId, session)
        assert.equal(f.starts[1].worktreeName, f.starts[0].worktreeName)
        const status = await call(client, 'regent_get_run', { run_id: work.run_id })
        assert.equal(status.latest_run.id, continued.run_id)
        assert.equal(status.latest_run.state, 'completed')
        assert.equal(status.question, null)
        assert.deepEqual(f.messages, [])
      } finally {
        await f.close()
      }
    },
  )
  await check(
    'cancel pauses its conversation and preserves queued follow-ups; service ignores CLI queues',
    async () => {
      const f = await fixture({ concurrency: 1 })
      try {
        f.state.scenario = 'hang'
        const client = await f.client()
        const work = await start(client)
        await until(() => Boolean(f.store.conversation(work.conversation_id).session_id))
        const queued = await call(client, 'regent_continue', {
          conversation_id: work.conversation_id,
          request_id: randomUUID(),
          prompt: 'Agrega un filtro',
        })
        const cli = f.store.accept(
          {
            adapter: 'cli',
            eventId: 'cli',
            key: 'cli:test',
            author: 'U1',
            text: 'unrelated',
            channel: 'test',
          },
          f.repo,
          24,
        )
        await call(client, 'regent_cancel', { conversation_id: work.conversation_id })
        await until(() => !f.core.active.size)
        assert.equal(f.store.run(work.run_id).state, 'interrupted')
        assert.equal(f.store.run(queued.run_id).state, 'queued')
        assert.equal(f.store.run(cli.runId).state, 'queued')
        f.state.scenario = 'success'
        await call(client, 'regent_continue', {
          conversation_id: work.conversation_id,
          request_id: randomUUID(),
          prompt: 'Continua',
        })
        await until(() => !f.core.active.size)
        assert.equal(f.store.run(queued.run_id).state, 'completed')
        assert.equal(f.store.run(cli.runId).state, 'queued')
      } finally {
        await f.close()
      }
    },
  )
  await check('restart recovery is adapter-scoped and leaves CLI work untouched', async () => {
    const f = await fixture()
    try {
      const mcp = f.store.accept(
        {
          adapter: 'mcp',
          eventId: 'persist',
          key: 'mcp:alice:persist',
          author: 'mcp:alice',
          text: 'Persist',
          channel: 'persist',
        },
        f.repo,
        24,
      )
      const cli = f.store.accept(
        {
          adapter: 'cli',
          eventId: 'cli-running',
          key: 'cli:running',
          author: 'U1',
          text: 'CLI',
          channel: 'cli',
        },
        f.repo,
        24,
      )
      f.store.start(mcp.runId)
      f.store.start(cli.runId)
      f.store.session('mcp:alice:persist', 'preserved-session')
      await f.core.recover()
      assert.equal(f.store.run(mcp.runId).state, 'interrupted')
      assert.equal(f.store.run(cli.runId).state, 'running')
      assert.equal(f.store.conversation('mcp:alice:persist').session_id, 'preserved-session')
      const client = await f.client()
      const status = await call(client, 'regent_get_run', { run_id: mcp.runId })
      assert.match(status.progress, /reinicio/)
      assert.deepEqual(f.messages, [])
    } finally {
      await f.close()
    }
  })
  await check('MCP conversations and status survive a real SQLite close/reopen', async () => {
    const f = await fixture({ file: path.join(root, 'persist.sqlite') })
    const work = f.store.accept(
      {
        adapter: 'mcp',
        eventId: 'persist-file',
        key: 'mcp:alice:file',
        author: 'mcp:alice',
        text: 'Persist',
        channel: 'persist',
      },
      f.repo,
      24,
    )
    f.store.start(work.runId)
    f.store.session('mcp:alice:file', 'saved-session')
    await f.close()
    const store = new Store(path.join(root, 'persist.sqlite'))
    const core = new Core({
      store,
      config: f.core.config,
      cwd: f.dir,
      output: mcpOutput(store),
      adapter: 'mcp',
    })
    try {
      await core.recover()
      const gateway = new ExternalMcp(core, tokens)
      const status = gateway.status('mcp:alice', work.runId)
      assert.equal(status.run.state, 'interrupted')
      assert.equal(status.conversation_id, 'mcp:alice:file')
      assert.equal(store.conversation('mcp:alice:file').session_id, 'saved-session')
      assert.match(status.progress, /reinicio/)
    } finally {
      await core.close()
      store.close()
    }
  })
  await check(
    'Slack and MCP share the concurrency limit and route replies only to their own adapter',
    async () => {
      const f = await fixture({ concurrency: 1 })
      try {
        f.state.scenario = 'hang'
        const client = await f.client()
        const work = await start(client)
        await until(() => Boolean(f.store.conversation(work.conversation_id).session_id))
        const slack = await f.core.submit({
          adapter: 'slack',
          eventId: 'mixed',
          key: 'slack:C1:1',
          author: 'U1',
          text: 'Revisa el repo',
          channel: 'C1',
          thread: '1',
          team: 'T1',
        })
        assert.equal(f.store.run(slack.runId).state, 'queued')
        assert.equal(f.starts.length, 1)
        f.state.scenario = 'success'
        await call(client, 'regent_cancel', { conversation_id: work.conversation_id })
        await until(() => !f.core.active.size)
        assert.equal(f.store.run(slack.runId).state, 'completed')
        assert.ok(f.messages.some((message) => message.kind === 'finish'))
        assert.ok(f.messages.every((message) => message.args[0].adapter === 'slack'))
      } finally {
        await f.close()
      }
    },
  )
  await check(
    'simulated agent creates, modifies and deletes a chart through MCP in the same real Git worktree',
    async () => {
      const f = await fixture()
      const git = (...args) => execFileSync('git', args, { cwd: f.repo, stdio: 'pipe' })
      fs.writeFileSync(path.join(f.repo, 'README.md'), 'Dashboard fixture\n')
      git('add', 'README.md')
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        'Initial fixture',
      )
      let isolated
      const runner = f.core.runner
      f.core.runner = (args) => {
        const active = f.core.byToken(args.token)
        isolated = isolationFor(args.cwd, active.run.conversation_key)
        if (!fs.existsSync(isolated.dir)) git('worktree', 'add', '-b', isolated.name, isolated.dir)
        const chart = path.join(isolated.dir, 'chart.tsx')
        if (args.prompt.includes('fixture:create'))
          fs.writeFileSync(chart, 'export const title = "Ofertas"\n')
        if (args.prompt.includes('fixture:edit'))
          fs.writeFileSync(chart, 'export const title = "Ofertas semanales"\n')
        if (args.prompt.includes('fixture:delete')) fs.unlinkSync(chart)
        return runner(args)
      }
      try {
        const client = await f.client()
        const work = await start(client, { prompt: 'fixture:create' })
        await until(() => !f.core.active.size)
        assert.match(fs.readFileSync(path.join(isolated.dir, 'chart.tsx'), 'utf8'), /Ofertas/)
        assert.equal(fs.existsSync(path.join(f.repo, 'chart.tsx')), false)
        await call(client, 'regent_continue', {
          conversation_id: work.conversation_id,
          request_id: randomUUID(),
          prompt: 'fixture:edit',
        })
        await until(() => !f.core.active.size)
        assert.match(
          fs.readFileSync(path.join(isolated.dir, 'chart.tsx'), 'utf8'),
          /Ofertas semanales/,
        )
        await call(client, 'regent_continue', {
          conversation_id: work.conversation_id,
          request_id: randomUUID(),
          prompt: 'fixture:delete',
        })
        await until(() => !f.core.active.size)
        assert.equal(fs.existsSync(path.join(isolated.dir, 'chart.tsx')), false)
        assert.equal(new Set(f.starts.map((args) => args.worktreeName)).size, 1)
        assert.equal(f.starts[1].sessionId, f.starts[2].sessionId)
        assert.deepEqual(f.messages, [])
      } finally {
        await f.close()
      }
    },
  )
  await check(
    'transport tokens are removed even when present in service and repository environments',
    async () => {
      const saved = process.env.REGENT_MCP_TOKEN_ALICE
      process.env.REGENT_MCP_TOKEN_ALICE = tokens.REGENT_MCP_TOKEN_ALICE
      const f = await fixture()
      try {
        fs.writeFileSync(
          path.join(f.repo, '.env'),
          `REGENT_MCP_TOKEN_BOB=${tokens.REGENT_MCP_TOKEN_BOB}\nREGENT_MCP_TOKEN=fixture-private\nREGENT_MCP_URL=https://private.invalid/mcp\nPROJECT_VALUE=preserved\n`,
        )
        const client = await f.client()
        await start(client)
        await until(() => !f.core.active.size)
        for (const key of [...Object.keys(tokens), 'REGENT_MCP_TOKEN', 'REGENT_MCP_URL'])
          assert.equal(f.starts[0].env[key], undefined)
        assert.equal(f.starts[0].env.PROJECT_VALUE, 'preserved')
      } finally {
        await f.close()
        if (saved === undefined) delete process.env.REGENT_MCP_TOKEN_ALICE
        else process.env.REGENT_MCP_TOKEN_ALICE = saved
      }
    },
  )
  await check(
    'Desktop stdio connector forwards MCP tools and results to the authenticated HTTP runtime',
    async () => {
      const f = await fixture({ name: 'Talently Code' })
      const client = new Client({ name: 'desktop-fixture', version: '1' })
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve('src/adapters/mcp/client.ts')],
        env: { REGENT_MCP_URL: `${f.url}/mcp`, REGENT_MCP_TOKEN: tokens.REGENT_MCP_TOKEN_ALICE },
        stderr: 'pipe',
      })
      let stderr = ''
      transport.stderr?.on('data', (chunk) => {
        stderr += chunk
      })
      try {
        await client.connect(transport)
        assert.deepEqual(client.getServerVersion(), {
          name: 'regent',
          title: 'Talently Code',
          version: '0.3.0',
        })
        assert.equal((await client.listTools()).tools.length, 6)
        assert.equal(
          (await client.listTools()).tools.find((t) => t.name === 'regent_start').title,
          'Talently Code · Iniciar trabajo',
        )
        assert.equal(client.getInstructions(), f.gateway.instructions())
        assert.match(client.getInstructions(), /Talently Code/)
        assert.equal((await client.listResources()).resources[0].name, 'Progreso de Talently Code')
        const resource = await client.readResource({ uri: 'ui://regent/progress.html' })
        assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app')
        assert.match(resource.contents[0].text, /<h2 id="heading">Talently Code<\/h2>/)
        assert.equal(
          (await client.listTools()).tools.find((t) => t.name === 'regent_get_run')._meta?.ui
            ?.resourceUri,
          undefined,
        )
        assert.equal(
          (await client.listTools()).tools.find((t) => t.name === 'regent_show_progress')._meta.ui
            .resourceUri,
          'ui://regent/progress.html',
        )
        const work = await start(client, { prompt: 'Modifica el titulo del grafico.' })
        await until(() => !f.core.active.size)
        const result = await call(client, 'regent_get_run', { run_id: work.run_id })
        assert.equal(result.run.state, 'completed')
        assert.match(result.run.result, /Modifica el titulo/)
        assert.doesNotMatch(stderr, new RegExp(tokens.REGENT_MCP_TOKEN_ALICE))
      } finally {
        await client.close()
        await f.close()
      }
    },
  )
  await check(
    'Desktop connector refuses unsafe URLs and missing tokens without echoing credentials',
    () => {
      for (const [url, token] of [
        ['http://remote.invalid/mcp', tokens.REGENT_MCP_TOKEN_ALICE],
        ['https://user:fixture-secret@remote.invalid/mcp', tokens.REGENT_MCP_TOKEN_ALICE],
        ['https://remote.invalid/mcp?token=fixture-secret', tokens.REGENT_MCP_TOKEN_ALICE],
        ['https://remote.invalid/mcp', ''],
      ]) {
        const child = spawnSync(process.execPath, [path.resolve('src/adapters/mcp/client.ts')], {
          env: { ...process.env, REGENT_MCP_URL: url, REGENT_MCP_TOKEN: token },
          encoding: 'utf8',
          timeout: 5000,
        })
        assert.equal(child.status, 1)
        assert.equal(child.stdout, '')
        assert.doesNotMatch(child.stderr, /fixture-secret|a{48}/)
      }
    },
  )
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
if (failed) process.exitCode = 1
