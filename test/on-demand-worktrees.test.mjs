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
import { readerDenial } from '../plugins/executor/hooks/readers.mjs'
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

  /** What the CLI does when the agent calls EnterWorktree: allowed by policy, created natively. */
  const enter = (key = 'conversation') => {
    const active = core.active.get(key)
    const isolation = isolationFor(repo, key)
    const call = { tool_name: 'EnterWorktree', tool_input: { name: isolation.name } }
    assert.equal(core.permission(active.token, call), null)
    git(repo, 'worktree', 'add', '-b', isolation.name, isolation.dir, 'HEAD')
    starts.at(-1).opts.onEvent({ kind: 'tool_result', id: 'enter-worktree', error: false })
    return isolation
  }

  return { root, repo, config, core, store, starts, input, submit, finish, enter }
}

for (const adapter of ['slack', 'mcp']) {
  test(`${adapter}: a conversation answers from the shared checkout and enters its worktree only to change code`, async (t) => {
    const f = fixture(t, adapter)
    const isolation = isolationFor(f.repo, 'conversation')
    const first = await f.submit('Explica cómo funciona este código')
    assert.equal(first.opts.worktreeName, undefined)
    assert.equal(first.opts.cwd, f.repo)
    assert.equal(first.opts.env.DEMAND_ROOT_VALUE, 'source-context')
    assert.ok(first.opts.prompt.includes(`"worktree":{"name":"${isolation.name}","entered":false}`))
    assert.equal(fs.existsSync(path.join(f.repo, '.claude/worktrees')), false)
    const args = runnerArgs(first.opts)
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'bypassPermissions')
    assert.ok(!args.includes('--tools'), 'every run keeps every native tool')
    assert.ok(!args.includes('--worktree'))
    const token = () => f.core.active.get('conversation').token
    const decide = (tool_name, tool_input, cwd) =>
      f.core.permission(token(), { tool_name, tool_input, ...(cwd ? { cwd } : {}) })
    assert.equal(await f.core.prepareWorkspace(token(), 'Read'), null)

    // Investigation is free in the shared checkout; changing it is not.
    for (const command of [
      'unzip -o /srv/attachments/site.zip -d /tmp/site && ls /tmp/site',
      'python3 /tmp/inspect.py > /tmp/regent-inspect.txt 2>&1',
      'git log --oneline -5 && git status --short && pnpm test',
      'git fetch origin && git pull --ff-only',
    ]) {
      assert.equal(decide('Bash', { command }), null, command)
    }

    assert.equal(decide('Agent', { prompt: 'Summarize the spreadsheet' }), null)
    assert.equal(
      decide('Write', { file_path: path.join(os.tmpdir(), 'regent-scratch', 'notes.py') }),
      null,
    )
    const hint = new RegExp(`EnterWorktree with name "${isolation.name}"`)
    assert.match(decide('Write', { file_path: 'answer.txt' }), hint)
    assert.match(decide('Edit', { file_path: path.join(f.repo, 'answer.txt') }), hint)
    assert.match(decide('Bash', { command: 'echo bad > answer.txt' }), hint)
    assert.ok(decide('Write', { file_path: path.join(os.homedir(), '.profile') }))

    for (const command of [
      'git checkout -b feature',
      'git commit -am "Change"',
      'git -c user.name=x reset --hard HEAD~1',
      'pnpm install',
      'npm ci',
    ]) {
      assert.match(decide('Bash', { command }), /Every conversation reads this checkout/, command)
    }

    assert.match(decide('EnterWorktree', { name: 'somewhere-else' }), hint)
    assert.match(decide('EnterWorktree', { name: isolation.name, path: '/tmp/x' }), hint)
    assert.ok(decide('ExitWorktree', {}))
    const inventory = await f.core.tool(token(), 'regent_git_read', {
      operation: 'worktrees',
      args: ['--porcelain'],
    })

    assert.equal((inventory.output.match(/^worktree /gm) ?? []).length, 1)
    const session = f.store.conversation('conversation').session_id
    await f.finish('Investigated evidence: answer.txt contains original.')

    // The change request continues the same session; the agent enters the worktree mid-run.
    const edit = await f.submit('Implementa el cambio investigado')
    assert.equal(edit.opts.sessionId, session)
    assert.equal(edit.opts.worktreeName, undefined)
    const { dir } = f.enter()
    assert.equal(f.store.conversation('conversation').session_id, session)
    assert.equal(f.store.conversation('conversation').session_cwd, dir)
    assert.equal(f.store.lastEvent(edit.opts.runId, 'worktree_entered').directory, dir)
    assert.equal(decide('Write', { file_path: 'answer.txt' }), null)
    assert.equal(decide('Write', { file_path: 'answer.txt' }, dir), null)
    assert.ok(decide('Write', { file_path: path.join(f.repo, 'answer.txt') }, dir))
    assert.equal(decide('Bash', { command: 'pnpm install && git commit -am "Change"' }, dir), null)
    assert.match(
      decide('Bash', { command: 'git checkout main' }, f.repo),
      /Every conversation reads this checkout/,
    )
    assert.match(decide('EnterWorktree', { name: isolation.name }), /already works in its worktree/)
    fs.writeFileSync(path.join(dir, 'answer.txt'), 'edited\n')
    await f.finish('Change completed in the isolated worktree.')

    // A profile only selects model and time limit: later runs resume in the worktree either way.
    const follow = await f.submit('/ask Explica qué cambiaste')
    assert.equal(f.store.latestRun('conversation').intent, 'ask')
    assert.equal(follow.opts.worktreeName, isolation.name)
    assert.equal(follow.opts.sessionId, session)
    assert.ok(follow.opts.prompt.includes(`"worktree":{"name":"${isolation.name}","entered":true}`))
    assert.equal(
      (git(f.repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm) ?? []).length,
      2,
    )
    const diff = await f.core.tool(token(), 'regent_git_read', {
      operation: 'diff',
      args: ['--', 'answer.txt'],
    })

    assert.match(diff.output, /edited/)
    assert.equal(decide('Edit', { file_path: 'answer.txt' }), null)
    assert.ok(decide('Bash', { command: `echo bad > ${path.join(f.repo, 'answer.txt')}` }))
    assert.equal(fs.readFileSync(path.join(f.repo, 'answer.txt'), 'utf8'), 'original\n')
    await f.finish()
  })
}

test('one conversation works in its worktree while another stays on the shared checkout', async (t) => {
  const f = fixture(t)
  await f.submit('Corrige el texto del archivo')
  const { dir } = f.enter()
  await f.finish()
  const other = await f.submit('Dime cuántos archivos hay', 'independent')
  assert.equal(other.opts.worktreeName, undefined)
  assert.equal(other.opts.cwd, f.repo)
  assert.ok(
    f.core.permission(f.core.active.get('independent').token, {
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'answer.txt') },
    }),
    "another conversation's worktree is not editable",
  )
  await f.finish()
  assert.equal(
    (git(f.repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm) ?? []).length,
    2,
  )
})

test('credential files, unknown tools and the policy endpoint behave the same for every profile', async (t) => {
  const f = fixture(t)
  await f.submit('/ask Investiga el repositorio sin hacer cambios')
  const active = [...f.core.active.values()][0]
  const server = createHttp(f.core, () => ({}))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const decide = async (tool_name, tool_input = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/tool-policy`, {
      method: 'POST',
      headers: { authorization: `Bearer ${active.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tool_name, tool_input, cwd: f.repo }),
    })

    assert.equal(response.status, 200)
    return (await response.json()).reason
  }

  assert.ok(await decide('Write', { file_path: 'answer.txt' }))
  assert.ok(await decide('Read', { file_path: '.credentials.json' }))
  assert.ok(await decide('Bash', { command: 'cat ~/.claude/.credentials.json' }))
  assert.equal(await decide('Read', { file_path: 'answer.txt' }), null)
  assert.equal(await decide('Bash', { command: 'unzip -l /tmp/attached.zip' }), null)
  assert.equal(await decide('mcp__notion__create_page', { title: 'Guide' }), null)
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

function addSubmodule(f, name, destination) {
  const child = path.join(f.root, name)
  init(child)
  git(f.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, destination)
  git(f.repo, 'commit', '-am', `Submodule ${destination}`)
  return child
}

const worktreeCount = (repo) =>
  (git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm) ?? []).length

test('submodule investigation uses source; editing checks out only the submodules the executor requests', async (t) => {
  const f = fixture(t)
  addSubmodule(f, 'child', 'backend/api')
  addSubmodule(f, 'web', 'frontend/web')
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
  f.enter()
  active = [...f.core.active.values()][0]
  const dir = isolationFor(f.repo, 'conversation').dir
  assert.equal(await f.core.prepareWorkspace(active.token, 'Edit'), null)
  assert.ok(!fs.existsSync(path.join(dir, 'backend/api/.git')))
  assert.ok(!fs.existsSync(path.join(dir, 'frontend/web/.git')))
  assert.deepEqual(active.workspace.pending.sort(), ['backend/api', 'frontend/web'])

  const edit = (file) =>
    f.core.permission(active.token, {
      tool_name: 'Edit',
      tool_input: { file_path: file },
      cwd: dir,
    })

  assert.match(edit('backend/api/answer.txt'), /regent_use_repo with "backend\/api"/)
  assert.match(
    f.core.permission(active.token, {
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test' },
      cwd: path.join(dir, 'backend/api'),
    }),
    /regent_use_repo/,
  )
  assert.equal(
    f.core.permission(active.token, {
      tool_name: 'Read',
      tool_input: { file_path: path.join(f.repo, 'frontend/web/answer.txt') },
      cwd: dir,
    }),
    null,
  )

  const results = await Promise.all(
    [path.join(dir, 'backend/api'), 'repo/backend/api', 'backend/api'].map((repo) =>
      f.core.tool(active.token, 'regent_use_repo', { repo, handoff: 'Change the backend.' }),
    ),
  )

  for (const result of results) {
    assert.equal(result.cwd, path.join(dir, 'backend/api'))
    assert.deepEqual(result.prepared, ['backend/api'])
  }

  assert.equal(fs.readFileSync(path.join(dir, 'backend/api/answer.txt'), 'utf8'), 'original\n')
  assert.ok(!fs.existsSync(path.join(dir, 'frontend/web/.git')))
  assert.equal(edit('backend/api/answer.txt'), null)
  assert.match(edit('frontend/web/answer.txt'), /regent_use_repo with "frontend\/web"/)
  assert.equal(worktreeCount(path.join(f.repo, 'backend/api')), 2)
  assert.equal(worktreeCount(path.join(f.repo, 'frontend/web')), 1)
  assert.equal(f.starts.at(-1).opts.env.DEMAND_ROOT_VALUE, 'source-context')
  await f.finish()

  await f.submit('/ask Explica el frontend')
  active = [...f.core.active.values()][0]
  assert.equal(active.executionDir, dir)
  assert.equal(await f.core.prepareWorkspace(active.token, 'Read'), null)
  assert.match(
    f.core.permission(active.token, {
      tool_name: 'Read',
      tool_input: { file_path: 'frontend/web/answer.txt' },
      cwd: dir,
    }),
    /shared checkout at .*frontend\/web/,
  )
  assert.equal(
    f.core.permission(active.token, {
      tool_name: 'Read',
      tool_input: { file_path: 'backend/api/answer.txt' },
      cwd: dir,
    }),
    null,
  )
  // A profile changes no capability: once in the worktree, any run may request a checkout.
  const requested = await f.core.tool(active.token, 'regent_use_repo', {
    repo: path.join(dir, 'frontend/web'),
    handoff: 'Work on the frontend.',
  })

  assert.equal(requested.cwd, path.join(dir, 'frontend/web'))
  assert.deepEqual(requested.prepared, ['frontend/web'])
  assert.ok(fs.existsSync(path.join(dir, 'frontend/web/.git')))
  await f.finish()
})

test('a nested submodule request checks out its enclosing submodule, and unavailable ones fail', async (t) => {
  const f = fixture(t)
  const outer = path.join(f.root, 'outer')
  const inner = path.join(f.root, 'inner')
  init(inner)
  init(outer)
  git(outer, '-c', 'protocol.file.allow=always', 'submodule', 'add', inner, 'lib/inner')
  git(outer, 'commit', '-am', 'Nested')
  git(f.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', outer, 'services/outer')
  git(f.repo, 'commit', '-am', 'Outer')
  git(f.repo, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive')
  addSubmodule(f, 'missing', 'services/missing')
  git(f.repo, 'submodule', 'deinit', '-f', 'services/missing')
  await f.submit('Cambia la libreria interna')
  f.enter()
  const active = [...f.core.active.values()][0]
  const dir = isolationFor(f.repo, 'conversation').dir
  assert.equal(await f.core.prepareWorkspace(active.token, 'Edit'), null)
  assert.deepEqual(active.workspace.pending, ['services/outer'])
  assert.deepEqual(active.workspace.unavailable, ['services/missing'])
  const result = await f.core.tool(active.token, 'regent_use_repo', {
    repo: 'repo/services/outer/lib/inner',
    handoff: 'Change the inner library.',
  })

  assert.deepEqual(result.prepared, ['services/outer', 'services/outer/lib/inner'])
  assert.equal(result.cwd, path.join(dir, 'services/outer/lib/inner'))
  assert.deepEqual(active.workspace.submodules, ['services/outer', 'services/outer/lib/inner'])
  assert.deepEqual(active.workspace.pending, [])
  assert.match(
    f.core.permission(active.token, {
      tool_name: 'Edit',
      tool_input: { file_path: 'services/missing/answer.txt' },
      cwd: dir,
    }),
    /no esta inicializado/,
  )
  assert.ok(!fs.existsSync(path.join(dir, 'services/missing/.git')))
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
    f.enter()
    const reading = { kind: 'tool_use', id: 'read-code', name: 'Grep' }
    f.store.event(active.run.id, reading.kind, reading)
    f.core.output.activity(active.conversation, active.run, reading)
    await slack.activities.flush()
    if (blocked) {
      const destination = path.join(isolationFor(f.repo, 'conversation').dir, 'backend/api')
      fs.mkdirSync(destination, { recursive: true })
      fs.writeFileSync(path.join(destination, 'keep.txt'), 'existing local work')
    }
    assert.equal(await f.core.prepareWorkspace(active.token, 'Edit'), null)
    const preparation = f.core.tool(active.token, 'regent_use_repo', {
      repo: 'repo/backend/api',
      handoff: 'Review the backend.',
    })
    if (blocked) await assert.rejects(preparation, /contiene archivos/)
    else assert.deepEqual((await preparation).prepared, ['backend/api'])
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
    if (!fs.existsSync(isolated)) f.enter()
    const active = [...f.core.active.values()][0]
    assert.equal(await f.core.prepareWorkspace(active.token, 'Edit'), null)
    return active
  }
  const first = await prepare()
  await f.core.tool(first.token, 'regent_use_repo', { repo: 'repo/web', handoff: 'Change it.' })
  assert.ok(fs.existsSync(path.join(isolated, 'web/.git')))
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
    assert.ok(readerDenial({ tool_name: 'mcp__fixture__execute_sql', tool_input: { query } }))
  }

  assert.ok(readerDenial({ tool_name: 'mcp__fixture__execute_sql', tool_input: {} }))
  assert.ok(readerDenial({ tool_name: 'mcp__fixture__delete_and_query', tool_input: {} }))
  assert.equal(
    readerDenial({
      tool_name: 'mcp__notion__API-post-search',
      tool_input: { query: 'Create project guide' },
    }),
    null,
  )
  assert.ok(
    readerDenial({
      tool_name: 'mcp__db__query_sql',
      tool_input: { payload: { SQL: 'DELETE FROM users' } },
    }),
  )
  assert.ok(
    readerDenial({
      tool_name: 'mcp__data__query_db',
      tool_input: { sql: 'SELECT id FROM users; DELETE FROM users' },
    }),
  )
})
