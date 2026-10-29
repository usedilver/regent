import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Store } from '../src/storage/store.ts'
import { Core } from '../src/core/core.ts'
import { ConfigSchema } from '../src/config.ts'
import { isolationFor } from '../src/core/repository.ts'
import { queryGit } from '../src/core/query-git.ts'
import { runnerArgs } from '../src/execution/runner.ts'
import { queryDenial } from '../plugins/executor/hooks/query.mjs'
import { denial } from '../plugins/executor/hooks/policy.mjs'
import { createHttp } from '../src/adapters/http.ts'
import { SlackOutput } from '../src/adapters/slack/output.ts'
import { SlackActivities } from '../src/adapters/slack/activities.ts'
import { DurableOutput } from '../src/storage/delivery.ts'
import { mcpActivities } from '../src/adapters/mcp/activities.ts'

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const output = { async notice() {}, async status() {}, async delta() {}, async finish() {} }
const done = (text) => ({ state: 'completed', text, cost: 0, usage: {}, error: '' })

const until = async (predicate) => {
  const limit = Date.now() + 5000

  while (!predicate()) {
    if (Date.now() > limit) throw new Error('Timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function init(repo) {
  fs.mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.name', 'Fixture')
  git(repo, 'config', 'user.email', 'fixture@example.test')
  fs.writeFileSync(path.join(repo, 'answer.txt'), 'original\n')
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/\n.env\n')
  fs.writeFileSync(path.join(repo, '.mcp.json'), '{"mcpServers":{}}\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'Initial')
}

function fixture(t, adapter = 'slack') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-demand-')))
  const repo = path.join(root, 'repo')

  init(repo)
  fs.writeFileSync(path.join(repo, '.env'), 'DEMAND_ROOT_VALUE=source-context\n')
  const store = new Store(path.join(root, 'state.sqlite'))
  const starts = []
  const config = ConfigSchema.parse({
    auth: { mode: 'indie' },
    repos: { path: root, default_repo: 'repo' },
    slack: { workspace_team_id: 'T1', allowed_users: ['U1'] },
    mcp: { enabled: true, principals: [{ id: 'fixture', token_env: 'REGENT_MCP_TOKEN_FIXTURE' }] },
  })
  const core = new Core({
    store,
    config,
    cwd: root,
    output,
    runner: (opts) => {
      if (opts.worktreeName) {
        const dir = path.join(opts.cwd, '.claude/worktrees', opts.worktreeName)

        if (!fs.existsSync(path.join(dir, '.git'))) {
          git(opts.cwd, 'worktree', 'add', '-b', opts.worktreeName, dir, 'HEAD')
        }
      }

      let finish
      const controller = {
        opts,
        done: new Promise((resolve) => {
          finish = resolve
        }),
        finish: (text = 'result') => finish(done(text)),
        cancel: () => finish(done('cancelled')),
      }

      starts.push(controller)
      opts.onEvent({ kind: 'init', sessionId: opts.sessionId ?? randomUUID() })
      return controller
    },
  })

  t.after(async () => {
    await core.close()
    store.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const input = (text, key = 'conversation') => ({
    adapter,
    eventId: randomUUID(),
    key,
    author: adapter === 'mcp' ? 'mcp:fixture' : 'U1',
    team: 'T1',
    channel: 'C1',
    text,
  })

  const submit = async (text, key) => {
    await core.submit(input(text, key))
    await until(() => starts.length && core.active.size)
    return starts.at(-1)
  }

  const finish = async (text) => {
    starts.at(-1).finish(text)
    await until(() => !core.active.size)
  }

  return { root, repo, config, core, store, starts, input, submit, finish }
}

for (const adapter of ['slack', 'mcp']) {
  test(`${adapter}: preview requests reuse edited work and later questions retain query restrictions`, async (t) => {
    const f = fixture(t, adapter)
    const edit = await f.submit('Corrige el texto del archivo')
    await f.finish()
    const session = f.store.conversation('conversation').session_id
    const preview = await f.submit('/ask Dame un preview para revisarlo antes de hacer PR')
    assert.equal(f.store.latestRun('conversation').intent, 'ask')
    assert.equal(preview.opts.readOnly, true)
    assert.equal(preview.opts.sessionId, session)
    assert.equal(preview.opts.worktreeName, edit.opts.worktreeName)
    await f.finish()

    const query = await f.submit('/ask Explica por qué falló el preview')
    assert.equal(query.opts.readOnly, true)
    assert.equal(query.opts.sessionId, session)
    assert.equal(query.opts.worktreeName, edit.opts.worktreeName)
    await f.finish()

    await f.core.submit({ ...f.input('Levanta un preview'), intent: 'ask' })
    await until(() => f.starts.length === 4)
    assert.equal(f.starts.at(-1).opts.readOnly, true)
    assert.equal(f.store.latestRun('conversation').intent, 'ask')
    await f.finish()
  })

  test(`${adapter}: query, edit and later query share the conversation without unnecessary worktrees`, async (t) => {
    const f = fixture(t, adapter)
    const first = await f.submit('/ask Explica cómo funciona este código')
    assert.ok(first.opts.readOnly)
    assert.equal(first.opts.worktreeName, undefined)
    assert.equal(first.opts.cwd, f.repo)
    assert.equal(first.opts.env.DEMAND_ROOT_VALUE, 'source-context')
    assert.equal(fs.existsSync(path.join(f.repo, '.claude/worktrees')), false)
    assert.equal(await f.core.prepareWorkspace([...f.core.active.values()][0].token, 'Read'), null)
    const args = runnerArgs(first.opts)
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'bypassPermissions')
    assert.doesNotMatch(args[args.indexOf('--tools') + 1], /Bash|Write|Edit|Agent/)
    assert.ok(!args.includes('--worktree'))
    const inventory = await f.core.tool([...f.core.active.values()][0].token, 'regent_git_read', {
      operation: 'worktrees',
      args: ['--porcelain'],
    })

    assert.equal((inventory.output.match(/^worktree /gm) ?? []).length, 1)
    const session = f.store.conversation('conversation').session_id
    await f.finish('Investigated evidence: answer.txt contains original.')
    const continued = await f.submit('/ask Continua con la investigación')
    assert.equal(continued.opts.sessionId, session)
    assert.equal(continued.opts.worktreeName, undefined)
    await f.finish('The investigation recommends changing answer.txt.')
    const edit = await f.submit('Implementa el cambio investigado')
    assert.equal(edit.opts.readOnly, false)
    assert.equal(edit.opts.sessionId, null)
    assert.match(edit.opts.prompt, /Investigated evidence/)
    assert.match(edit.opts.prompt, /investigación/)
    const dir = isolationFor(f.repo, 'conversation').dir
    assert.ok(fs.existsSync(path.join(dir, '.git')))
    const editSession = f.store.conversation('conversation').session_id
    assert.notEqual(editSession, session)
    assert.equal(f.store.conversation('conversation').session_cwd, dir)
    const active = [...f.core.active.values()][0]
    assert.equal(
      f.core.permission(active.token, {
        tool_name: 'Write',
        tool_input: { file_path: 'answer.txt' },
        cwd: dir,
      }),
      null,
    )
    assert.ok(
      f.core.permission(active.token, {
        tool_name: 'Write',
        tool_input: { file_path: path.join(f.repo, 'answer.txt') },
        cwd: dir,
      }),
    )
    fs.writeFileSync(path.join(dir, 'answer.txt'), 'edited\n')
    await f.finish('Change completed in the isolated worktree.')
    const follow = await f.submit('/ask Explica qué cambiaste')
    assert.equal(follow.opts.readOnly, true)
    assert.equal(follow.opts.worktreeName, edit.opts.worktreeName)
    assert.equal(follow.opts.sessionId, editSession)
    assert.equal(
      (git(f.repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm) ?? []).length,
      2,
    )
    const token = [...f.core.active.values()][0].token
    const diff = await f.core.tool(token, 'regent_git_read', {
      operation: 'diff',
      args: ['--', 'answer.txt'],
    })

    assert.match(diff.output, /edited/)
    assert.ok(
      f.core.permission(token, {
        tool_name: 'Bash',
        tool_input: { command: 'echo bad > answer.txt' },
      }),
    )
    assert.equal(fs.readFileSync(path.join(f.repo, 'answer.txt'), 'utf8'), 'original\n')
    await f.finish()
  })
}

test('editing first creates isolation immediately, while another query conversation stays on source', async (t) => {
  const f = fixture(t)
  const edit = await f.submit('Corrige el texto del archivo')
  assert.ok(edit.opts.worktreeName)
  await f.finish()
  const query = await f.submit('/ask Dime cuántos archivos hay', 'independent-query')
  assert.equal(query.opts.worktreeName, undefined)
  assert.equal(query.opts.readOnly, true)
  await f.finish()
  assert.equal(
    (git(f.repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm) ?? []).length,
    2,
  )
})

test('query permission hooks reject writers, interpreters, delegation, preview and automatic promotion', async (t) => {
  const f = fixture(t)
  await f.submit('/ask Investiga el repositorio sin hacer cambios')
  const active = [...f.core.active.values()][0]
  const server = createHttp(f.core, () => ({}))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/tool-policy`

  for (const tool_name of [
    'Write',
    'Edit',
    'NotebookEdit',
    'Bash',
    'PowerShell',
    'Agent',
    'Task',
    'EnterWorktree',
    'ExitPlanMode',
    'mcp__regent__regent_preview',
    'mcp__files__write_file',
    'mcp__data__query_db',
  ]) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${active.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        tool_name,
        tool_input: {
          file_path: 'answer.txt',
          command: "node -e \"require('fs').writeFileSync('answer.txt','bad')\"",
          sql: 'DELETE FROM users',
        },
        cwd: f.repo,
      }),
    })

    assert.equal(response.status, 200)
    assert.ok((await response.json()).reason, tool_name)
  }

  for (const input of [
    { tool_name: 'Read', tool_input: { file_path: 'answer.txt' } },
    { tool_name: 'mcp__data__query_db', tool_input: { sql: 'SELECT id FROM users LIMIT 1' } },
    { tool_name: 'mcp__notion__search', tool_input: { query: 'Create project guide' } },
  ]) {
    assert.equal(f.core.permission(active.token, input), null)
  }

  assert.ok(
    f.core.permission(active.token, {
      tool_name: 'Read',
      tool_input: { file_path: '.credentials.json' },
    }),
  )
  await assert.rejects(
    () =>
      f.core.tool(active.token, 'regent_use_repo', {
        repo: f.repo,
        intent: 'project',
        handoff: 'Agent self escalation',
      }),
    /cannot promote/,
  )
  await assert.rejects(
    () => f.core.tool(active.token, 'regent_preview', { action: 'status' }),
    /Tool desconocida/,
  )
  assert.equal(fs.existsSync(path.join(f.repo, '.claude/worktrees')), false)
  await f.finish()
})

test('Git reader rejects writes and shell expansion and disables repository executable filters', async (t) => {
  const f = fixture(t)
  const marker = path.join(f.root, 'marker')
  const outside = path.join(f.root, 'outside')

  fs.mkdirSync(outside)
  fs.symlinkSync(outside, path.join(f.repo, 'escape'))
  fs.writeFileSync(path.join(f.repo, '.gitattributes'), 'answer.txt filter=probe\n')
  git(f.repo, 'add', '.gitattributes')
  git(f.repo, 'commit', '-m', 'Attributes')
  git(f.repo, 'config', 'filter.probe.clean', `sh -c 'echo unsafe > "${marker}"; cat'`)
  git(f.repo, 'config', 'filter.probe.required', 'true')
  git(f.repo, 'config', 'core.fsmonitor', `sh -c 'echo unsafe > "${marker}"'`)
  fs.writeFileSync(path.join(f.repo, 'answer.txt'), 'different\n')
  const before = fs.readFileSync(path.join(f.repo, '.git/config'), 'utf8')
  assert.match((await queryGit(f.repo, 'diff', [])).output, /different/)
  assert.match((await queryGit(f.repo, 'log', ['-1', '--format=%s'])).output, /Attributes/)
  await queryGit(f.repo, 'status', ['--porcelain'])
  assert.equal(fs.existsSync(marker), false)
  assert.equal(fs.readFileSync(path.join(f.repo, '.git/config'), 'utf8'), before)

  for (const args of [
    ['--output=' + marker],
    ['--out=' + marker],
    ['--ext-diff'],
    ['--textconv'],
  ]) {
    await assert.rejects(() => queryGit(f.repo, 'diff', args), /option/)
  }

  await assert.rejects(() => queryGit(f.repo, 'checkout', ['main']), /not a reader/)
  await assert.rejects(() => queryGit(f.repo, 'status', [], 'escape'), /selected project/)
  await assert.rejects(() => queryGit(f.repo, 'show', ['HEAD; touch ' + marker]))
  assert.equal(fs.existsSync(marker), false)
})

test('independent queries use a new conversation and load only their own environment', async (t) => {
  const f = fixture(t)
  const other = path.join(f.root, 'other')

  init(other)
  fs.writeFileSync(path.join(other, '.env'), 'OTHER_ROOT_VALUE=independent\n')
  await f.submit('/ask Investiga el proyecto')
  const active = [...f.core.active.values()][0]
  await assert.rejects(
    () =>
      f.core.tool(active.token, 'regent_use_repo', {
        repo: other,
        handoff: 'Investigate the other repository in read mode.',
      }),
    /nueva conversación/,
  )
  await f.finish()
  await f.core.submit({
    ...f.input('Investiga este proyecto', 'other-project'),
    intent: 'ask',
    repo: other,
  })
  await until(() => f.starts.length === 2)
  assert.equal(f.starts[1].opts.cwd, other)
  assert.equal(f.starts[1].opts.worktreeName, undefined)
  assert.equal(f.starts[1].opts.sessionId, null)
  assert.equal(f.starts[1].opts.env.OTHER_ROOT_VALUE, 'independent')
  assert.equal(f.starts[1].opts.env.DEMAND_ROOT_VALUE, undefined)
  assert.ok(!fs.existsSync(path.join(f.repo, '.claude/worktrees')))
  assert.ok(!fs.existsSync(path.join(other, '.claude/worktrees')))
  await f.finish()
})

test('submodule investigation uses source; preparing an edit creates only then the nested checkouts', async (t) => {
  const f = fixture(t)
  const child = path.join(f.root, 'child')

  init(child)
  git(f.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'backend/api')
  git(f.repo, 'commit', '-am', 'Submodule')
  await f.submit('/ask Investiga el backend del proyecto')
  let active = [...f.core.active.values()][0]
  assert.equal(await f.core.prepareWorkspace(active.token, 'Read'), null)
  const read = await f.core.tool(active.token, 'regent_git_read', {
    operation: 'show',
    args: ['HEAD:answer.txt'],
    directory: 'backend/api',
  })

  assert.match(read.output, /original/)
  assert.ok(!fs.existsSync(path.join(f.repo, '.claude/worktrees')))
  await f.finish('Investigated the pinned backend.')
  await f.submit('Implementa el cambio en backend')
  active = [...f.core.active.values()][0]
  assert.equal(await f.core.prepareWorkspace(active.token, 'Edit'), null)
  const dir = isolationFor(f.repo, 'conversation').dir
  assert.ok(fs.existsSync(path.join(dir, 'backend/api/.git')))
  assert.equal(fs.readFileSync(path.join(dir, 'backend/api/answer.txt'), 'utf8'), 'original\n')
  assert.equal(f.starts.at(-1).opts.env.DEMAND_ROOT_VALUE, 'source-context')
  await f.finish()
})

for (const blocked of [false, true]) {
  test(`workspace preparation ${blocked ? 'failure' : 'success'} updates the existing activity card without a Slack notice`, async (t) => {
    const f = fixture(t)
    const child = path.join(f.root, 'child')
    init(child)
    git(f.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'backend/api')
    git(f.repo, 'commit', '-am', 'Submodule')
    const calls = []
    const slack = new SlackOutput(async (method, args) => {
      calls.push({ method, args })
      return { ts: 'activity-card' }
    })
    slack.activities = new SlackActivities(slack.api, f.store)
    f.core.output = new DurableOutput(f.store, slack)
    await f.core.submit({ ...f.input('Revisa el proyecto'), thread: '123.456' })
    await until(() => f.core.active.size)
    const active = [...f.core.active.values()][0]
    const reading = { kind: 'tool_use', id: 'read-code', name: 'Grep' }
    f.store.event(active.run.id, reading.kind, reading)
    f.core.output.activity(active.conversation, active.run, reading)
    await slack.activities.flush()
    if (blocked) {
      const destination = path.join(isolationFor(f.repo, 'conversation').dir, 'backend/api')
      fs.mkdirSync(destination, { recursive: true })
      fs.writeFileSync(path.join(destination, 'keep.txt'), 'existing local work')
    }
    const results = await Promise.all([
      f.core.prepareWorkspace(active.token, 'Edit'),
      f.core.prepareWorkspace(active.token, 'Read'),
    ])
    for (const result of results) {
      if (blocked) assert.match(result, /contiene archivos/)
      else assert.equal(result, null)
    }
    await active.output
    assert.deepEqual(
      f.store.db
        .prepare(
          "SELECT json_extract(data,'$.status') status FROM events WHERE run_id=? AND kind='workspace_preparation' ORDER BY id",
        )
        .all(active.run.id)
        .map((row) => row.status),
      ['running', blocked ? 'error' : 'complete'],
    )
    const reply = blocked ? 'Preparación bloqueada' : 'Revisión terminada'
    await f.finish(reply)
    await slack.activities.flush()
    const workspace = mcpActivities(f.store, f.store.run(active.run.id)).tasks.find(
      (task) => task.id === 'workspace',
    )
    assert.equal(workspace.status, blocked ? 'error' : 'complete')
    assert.equal(calls.filter((call) => call.method === 'chat.startStream').length, 1)
    assert.deepEqual(
      calls.filter((call) => call.method === 'chat.postMessage').map((call) => call.args.text),
      [reply],
    )
    const card = calls
      .findLast((call) => call.method === 'chat.update')
      .args.blocks.find((block) => block.task_id === 'workspace')
    assert.equal(card.status, workspace.status)
    assert.equal(
      f.store.db.prepare("SELECT count(*) n FROM deliveries WHERE kind='notice'").get().n,
      0,
    )
    if (blocked)
      assert.equal(
        fs.readFileSync(
          path.join(isolationFor(f.repo, 'conversation').dir, 'backend/api/keep.txt'),
          'utf8',
        ),
        'existing local work',
      )
  })
}

test('resumed submodules receive newly provisioned ignored setup files without overwriting their environment', async (t) => {
  const f = fixture(t)
  const child = path.join(f.root, 'child')
  init(child)
  fs.writeFileSync(path.join(child, '.worktreeinclude'), '.env\n')
  git(child, 'add', '.worktreeinclude')
  git(child, 'commit', '-m', 'Include runtime setup')
  git(f.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'web')
  git(f.repo, 'commit', '-am', 'Submodule')
  const isolated = isolationFor(f.repo, 'conversation').dir
  const prepare = async () => {
    await f.submit('Cambia el texto del boton')
    const active = [...f.core.active.values()][0]
    assert.equal(await f.core.prepareWorkspace(active.token, 'Edit'), null)
    return active
  }
  await prepare()
  assert.equal(fs.existsSync(path.join(isolated, 'web/.env')), false)
  await f.finish()
  fs.writeFileSync(path.join(f.repo, 'web/.env'), 'RUNTIME=provisioned\n', { mode: 0o600 })
  const active = await prepare()
  assert.equal(fs.readFileSync(path.join(isolated, 'web/.env'), 'utf8'), 'RUNTIME=provisioned\n')
  assert.equal(fs.statSync(path.join(isolated, 'web/.env')).mode & 0o777, 0o600)
  fs.writeFileSync(path.join(isolated, 'web/.env'), 'RUNTIME=conversation-specific\n')
  await f.finish()
  fs.writeFileSync(path.join(f.repo, 'web/.env'), 'RUNTIME=source-updated\n')
  await prepare()
  assert.equal(
    fs.readFileSync(path.join(isolated, 'web/.env'), 'utf8'),
    'RUNTIME=conversation-specific\n',
  )
  await f.finish()
})

test('legacy sessions reuse their existing worktree, and removed worktrees do not reappear on queries', async (t) => {
  const f = fixture(t)
  const accepted = f.store.accept(f.input('Review'), f.repo)
  f.store.finish(accepted.runId, 'completed', 'Previous research')
  const isolated = isolationFor(f.repo, 'conversation')
  git(f.repo, 'worktree', 'add', '-b', isolated.name, isolated.dir, 'HEAD')
  f.store.session('conversation', 'legacy-session')
  await f.submit('/ask Explica el código')
  assert.equal(f.starts.at(-1).opts.sessionId, 'legacy-session')
  assert.equal(f.starts.at(-1).opts.worktreeName, isolated.name)
  await f.finish()
  git(f.repo, 'worktree', 'remove', isolated.dir)
  const query = await f.submit('/ask Dime cómo funciona')
  assert.equal(query.opts.worktreeName, undefined)
  assert.equal(query.opts.sessionId, null)
  assert.match(query.opts.prompt, /Prior conversation handoff/)
  assert.ok(!fs.existsSync(isolated.dir))
  await f.finish()
})

test('configured read-only MCPs retain their reader contracts in both execution modes', () => {
  for (const [name, tool_input] of [
    ['execute_sql', { query: 'SELECT id FROM candidates LIMIT 1' }],
    ['mixpanel_query', { project: 'match', type: 'segmentation' }],
    ['ga4_report', { dimensions: ['date'], metrics: ['activeUsers'] }],
    ['audit_dictionary', {}],
  ]) {
    for (const REGENT_READ_ONLY of ['0', '1']) {
      assert.equal(
        denial(
          { tool_name: `mcp__fixture__${name}`, tool_input },
          {
            REGENT_READ_ONLY,
            REGENT_READONLY_MCP: '["fixture"]',
          },
        ),
        null,
        name,
      )
    }
  }

  for (const query of [
    'DELETE FROM candidates',
    'SELECT id FROM candidates; DELETE FROM candidates',
    'node -e writeFile()',
  ]) {
    assert.ok(queryDenial({ tool_name: 'mcp__fixture__execute_sql', tool_input: { query } }))
  }

  assert.ok(queryDenial({ tool_name: 'mcp__fixture__execute_sql', tool_input: {} }))
  assert.ok(queryDenial({ tool_name: 'mcp__fixture__delete_and_query', tool_input: {} }))
  assert.equal(
    queryDenial({
      tool_name: 'mcp__notion__API-post-search',
      tool_input: { query: 'Create project guide' },
    }),
    null,
  )
  assert.ok(
    queryDenial({
      tool_name: 'mcp__db__query_sql',
      tool_input: { payload: { SQL: 'DELETE FROM users' } },
    }),
  )
  assert.ok(
    queryDenial({
      tool_name: 'mcp__data__query_db',
      tool_input: { sql: 'SELECT id FROM users; DELETE FROM users' },
    }),
  )
})
