import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Core } from '../src/core.ts'
import { Store } from '../src/store.ts'
import { ConfigSchema } from '../src/config.ts'
import { resolveRepository, projectRoot, isolationFor } from '../src/repository.ts'
import { prepareProjectWorkspace } from '../src/project-workspace.ts'
import { repositoryContext } from '../src/repository-context.ts'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-projects-')))
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const repo = path.join(root, 'repo')
fs.mkdirSync(repo)
git(repo, 'init', '-b', 'main')
git(repo, 'config', 'user.name', 'Fixture')
git(repo, 'config', 'user.email', 'fixture@example.invalid')
fs.writeFileSync(path.join(repo, 'CLAUDE.md'), 'Use repository tools; no tracker for questions.\n')
fs.writeFileSync(path.join(repo, 'answer.txt'), 'before\n')
git(repo, 'add', '.')
git(repo, 'commit', '-m', 'Initial')

try {
  const clone = path.join(root, 'clone')
  git(root, 'clone', repo, clone)
  assert.equal(resolveRepository(root, 'clone'), fs.realpathSync(clone))
  assert.ok(!fs.existsSync(path.join(clone, '.regent')))
  const unborn = path.join(root, '..new-project')
  git(root, 'init', unborn)
  assert.equal(resolveRepository(root, unborn), fs.realpathSync(unborn))
  const worktree = path.join(root, 'worktree')
  git(repo, 'worktree', 'add', '-b', 'isolated', worktree)
  assert.equal(resolveRepository(root, worktree), fs.realpathSync(worktree))
  assert.throws(() => resolveRepository(root, os.tmpdir()), /workspace/)
  assert.throws(() => resolveRepository(root, 'missing'))
  assert.throws(() => resolveRepository(root, root), /repositorio existente/)
  fs.symlinkSync(os.tmpdir(), path.join(root, 'escape'))
  assert.throws(() => resolveRepository(root, 'escape'), /workspace/)
  console.log('  OK ordinary clones, unborn repos, worktrees and contained context selection')
  fs.writeFileSync(path.join(repo, '.env'), 'SYNTHETIC_TEST_VALUE=1\n')
  fs.symlinkSync(path.join(repo, '.env'), path.join(repo, 'secret-alias'))
  fs.symlinkSync(path.join(root, 'missing-target'), path.join(repo, 'broken-link'))

  for (const permission_mode of ['bypass', 'native']) {
    const store = new Store(':memory:')
    const config = ConfigSchema.parse({
      permission_mode,
      auth: { mode: 'indie' },
      repos: { path: root, default_repo: 'repo' },
      slack: { workspace_team_id: 'T1', allowed_users: ['U1'] },
    })
    let options
    const core = new Core({
      store,
      config,
      cwd: root,
      output: { async notice() {}, async status() {}, async delta() {}, async finish() {} },
      runner: (value) => {
        options = value
        const isolated = {
          name: value.worktreeName,
          dir: path.join(repo, '.claude/worktrees', value.worktreeName),
        }
        if (!fs.existsSync(isolated.dir))
          git(repo, 'worktree', 'add', '-b', `worktree-${isolated.name}`, isolated.dir, 'HEAD')
        let finish
        return {
          done: new Promise((resolve) => {
            finish = resolve
          }),
          cancel: () =>
            finish({ state: 'interrupted', text: '', error: 'stopped', cost: 0, usage: {} }),
        }
      },
    })
    try {
      const key = 'slack:C1:1'
      await core.submit({
        adapter: 'slack',
        key,
        eventId: 'edit',
        author: 'U1',
        channel: 'C1',
        thread: '1',
        team: 'T1',
        text: 'Change the text',
      })
      const active = [...core.active.values()][0]
      const permit = (tool_name, tool_input) =>
        core.permission(active.token, { tool_name, tool_input })
      assert.equal(options.cwd, fs.realpathSync(repo))
      assert.deepEqual(options.additionalDirectories, [])
      const isolated = isolationFor(repo, key)
      assert.equal(options.worktreeName, isolated.name)
      assert.doesNotMatch(options.prompt, /"policy"|"worktrees"|"task"/)
      for (const tool_name of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
        const field = tool_name === 'NotebookEdit' ? 'notebook_path' : 'file_path'
        assert.equal(permit(tool_name, { [field]: 'answer.txt' }), null)
        assert.ok(permit(tool_name, { [field]: path.join(unborn, 'nested/new.txt') }))
        assert.ok(permit(tool_name, { [field]: path.join(repo, 'answer.txt') }))
        assert.ok(permit(tool_name, { [field]: path.join(root, 'escape/outside.txt') }))
        assert.ok(permit(tool_name, { [field]: path.join(os.tmpdir(), 'outside.txt') }))
        assert.equal(permit(tool_name, { [field]: '.env.local' }), null) // build config del proyecto: editable dentro del worktree
        assert.ok(permit(tool_name, { [field]: '.credentials.json' })) // credencial dura: sigue bloqueada
      }
      assert.equal(permit('Write', { file_path: '.claude/settings.json' }), null)
      assert.equal(permit('Write', { file_path: '.mcp.json' }), null)
      fs.writeFileSync(path.join(isolated.dir, '.env.local'), 'FIRST=keep\nSECOND=old\n')
      assert.equal(permit('Read', { file_path: '.env.local' }), null)
      assert.equal(
        permit('Edit', {
          file_path: '.env.local',
          old_string: 'SECOND=old',
          new_string: 'SECOND=new',
        }),
        null,
      )
      fs.writeFileSync(
        path.join(isolated.dir, '.env.local'),
        fs
          .readFileSync(path.join(isolated.dir, '.env.local'), 'utf8')
          .replace('SECOND=old', 'SECOND=new'),
      )
      assert.equal(
        fs.readFileSync(path.join(isolated.dir, '.env.local'), 'utf8'),
        'FIRST=keep\nSECOND=new\n',
      )
      if (!fs.existsSync(path.join(isolated.dir, '.env.link')))
        fs.symlinkSync(path.join(repo, '.env'), path.join(isolated.dir, '.env.link'))
      for (const tool of ['Write', 'Edit']) {
        assert.ok(permit(tool, { file_path: path.join(repo, '.env') }))
        assert.ok(permit(tool, { file_path: '.env.link' }))
      }
      for (const command of [
        'vercel env pull .env.local',
        'git check-ignore .env.local',
        'cat .env.local',
      ])
        assert.equal(permit('Bash', { command }), null)
      for (const file_path of [path.join(repo, '.env'), '.env.link'])
        assert.equal(permit('Read', { file_path }), null)
      for (const command of [
        `cat ${repo}/.env`,
        'cat .env.link',
        'cd .. && cat .env',
        'git -C .. check-ignore .env',
        'git -C.. check-ignore .env',
        'cat ../.env',
        `chmod 600 ${repo}/.env && stat ${repo}/.env`,
        'grep -oE "^[A-Z_]+=" .env.local',
      ])
        assert.equal(permit('Bash', { command }), null)
      assert.ok(permit('Write', { file_path: path.join(repo, 'secret-alias') }))
      assert.ok(permit('Write', { file_path: path.join(repo, 'broken-link') }))
      for (const command of [
        'git add answer.txt',
        'git commit -m fix',
        'gh pr create',
        'pnpm test',
        'ncard create task',
      ]) {
        assert.equal(permit('Bash', { command }), null)
      }
      // Simulate the runtime using the approved repository tools, not core helpers.
      fs.writeFileSync(path.join(isolated.dir, 'answer.txt'), `${permission_mode}\n`)
      assert.match(git(isolated.dir, 'diff', '--', 'answer.txt'), new RegExp(permission_mode))
      git(isolated.dir, 'add', 'answer.txt')
      git(isolated.dir, 'commit', '-m', `Edit with ${permission_mode}`)
      const other = isolationFor(repo, 'slack:C2:2')
      await core.submit({
        adapter: 'slack',
        key: 'slack:C2:2',
        eventId: 'second',
        author: 'U1',
        channel: 'C2',
        thread: '2',
        team: 'T1',
        text: 'Another fix',
      })
      assert.equal(core.active.size, 2)
      const otherToken = core.active.get('slack:C2:2').token
      assert.equal(
        core.permission(otherToken, {
          tool_name: 'Write',
          tool_input: { file_path: path.join(other.dir, 'answer.txt') },
          cwd: other.dir,
        }),
        null,
      )
      assert.ok(
        core.permission(otherToken, {
          tool_name: 'Write',
          tool_input: { file_path: path.join(isolated.dir, 'answer.txt') },
          cwd: other.dir,
        }),
      )
      fs.writeFileSync(path.join(other.dir, 'answer.txt'), 'independent\n')
      assert.ok(permit('Write', { file_path: path.join(other.dir, 'answer.txt') }))
      assert.ok(
        core.permission(active.token, {
          tool_name: 'Bash',
          tool_input: { command: 'git status' },
          cwd: repo,
        }),
      )
      assert.ok(core.permission(active.token, { tool_name: 'ExitWorktree', tool_input: {} }))
      assert.equal(fs.readFileSync(path.join(repo, 'answer.txt'), 'utf8'), 'before\n')
      assert.equal(
        fs.readFileSync(path.join(isolated.dir, 'answer.txt'), 'utf8'),
        `${permission_mode}\n`,
      )
      assert.notEqual(
        git(isolated.dir, 'symbolic-ref', 'HEAD'),
        git(other.dir, 'symbolic-ref', 'HEAD'),
      )
      assert.equal(isolationFor(repo, key).dir, isolated.dir)
      for (const table of ['tasks', 'task_gates', 'worktrees', 'prs']) {
        assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0)
      }
      assert.ok(
        core.permission('expired', { tool_name: 'Edit', tool_input: { file_path: 'answer.txt' } }),
      )
      await core.tool(active.token, 'regent_ask_human', {
        question: 'Publish?',
        options: ['Yes', 'No'],
      })
      assert.ok(permit('Write', { file_path: 'answer.txt' }))
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM gates').get().n, 1)
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM task_gates').get().n, 0)
      console.log(
        `  OK ${permission_mode}: edits and commits without tasks, legacy policy ignored, conversational questions retained`,
      )
    } finally {
      await core.close()
      store.close()
    }
  }
  for (const name of ['plan', 'implement', 'qa']) {
    assert.ok(!fs.existsSync(path.resolve('plugin/skills', name, 'SKILL.md')))
  }
  const parent = path.join(root, 'parent')
  git(root, 'init', parent)
  git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', repo, 'hire')
  const hire = path.join(parent, 'hire')
  const a = isolationFor(hire, 'thread-A'),
    b = isolationFor(hire, 'thread-B')
  git(hire, 'worktree', 'add', '-b', a.name, a.dir, 'HEAD')
  git(hire, 'worktree', 'add', '-b', b.name, b.dir, 'HEAD')
  fs.writeFileSync(path.join(a.dir, 'answer.txt'), 'fix A')
  fs.writeFileSync(path.join(b.dir, 'answer.txt'), 'fix B')
  assert.equal(fs.readFileSync(path.join(hire, 'answer.txt'), 'utf8'), 'before\n')
  assert.equal(fs.readFileSync(path.join(a.dir, 'answer.txt'), 'utf8'), 'fix A')
  assert.equal(fs.readFileSync(path.join(b.dir, 'answer.txt'), 'utf8'), 'fix B')
  assert.notEqual(git(a.dir, 'symbolic-ref', 'HEAD'), git(b.dir, 'symbolic-ref', 'HEAD'))
  console.log('  OK two isolated worktrees of a submodule leave its shared checkout untouched')

  git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', repo, 'web')
  git(hire, '-c', 'protocol.file.allow=always', 'submodule', 'add', repo, 'services/nested')
  fs.writeFileSync(path.join(hire, '.gitignore'), '.env\n.claude/settings.local.json\n')
  fs.writeFileSync(path.join(hire, '.worktreeinclude'), '.env\n.claude/settings.local.json\n')
  fs.mkdirSync(path.join(hire, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(hire, '.claude/settings.local.json'), '{"fixture":true}\n')
  fs.writeFileSync(path.join(hire, '.env'), 'CHILD_SETUP=fixture\n')
  git(hire, 'add', '.gitmodules', 'services/nested', '.gitignore', '.worktreeinclude')
  git(
    hire,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Nested module and setup',
  )
  git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', repo, 'unavailable')
  git(parent, 'submodule', 'deinit', '-f', 'unavailable')
  fs.writeFileSync(path.join(parent, 'AGENTS.md'), 'Shared project instructions\n')
  fs.writeFileSync(
    path.join(parent, '.mcp.json'),
    JSON.stringify({ mcpServers: { shared: { command: 'fixture' } } }),
  )
  fs.mkdirSync(path.join(parent, '.claude/skills/shared-skill'), { recursive: true })
  fs.writeFileSync(path.join(parent, '.claude/skills/shared-skill/SKILL.md'), 'Shared skill\n')
  git(parent, 'add', '.')
  git(
    parent,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Project fixture',
  )
  const pinned = git(hire, 'rev-parse', 'HEAD')
  fs.writeFileSync(path.join(hire, 'answer.txt'), 'new canonical revision\n')
  git(hire, 'add', 'answer.txt')
  git(
    hire,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Unpinned source update',
  )

  assert.equal(projectRoot(root, hire), parent)
  assert.equal(projectRoot(root, path.join(hire, 'services/nested')), parent)
  assert.throws(() => projectRoot(hire, hire), /workspace/)
  const independent = path.join(parent, 'independent')
  git(parent, 'clone', repo, independent)
  assert.equal(projectRoot(root, independent), independent)
  assert.deepEqual(
    repositoryContext(root, independent).instruction_directories.map((entry) => entry.directory),
    ['parent/independent'],
  )
  const context = repositoryContext(root, hire)
  assert.equal(context.project_root, parent)
  assert.deepEqual(context.instruction_directories[0].configured_mcp_servers, ['shared'])
  assert.equal(context.instruction_directories[0].skills[0].name, 'shared-skill')

  const workspaceA = isolationFor(parent, 'project-A'),
    workspaceB = isolationFor(parent, 'project-B')
  for (const [key, isolated] of [
    ['project-A', workspaceA],
    ['project-B', workspaceB],
  ]) {
    git(parent, 'worktree', 'add', '-b', isolated.name, isolated.dir, 'HEAD')
    const prepared = await prepareProjectWorkspace(root, parent, isolated.dir, key)
    assert.deepEqual(prepared.submodules, ['hire', 'hire/services/nested', 'web'])
    assert.deepEqual(prepared.unavailable, ['unavailable'])
    assert.equal(git(path.join(isolated.dir, 'hire'), 'rev-parse', 'HEAD'), pinned)
    assert.equal(
      fs.readFileSync(path.join(isolated.dir, 'hire/.env'), 'utf8'),
      'CHILD_SETUP=fixture\n',
    )
    assert.equal(
      fs.readFileSync(path.join(isolated.dir, 'hire/.claude/settings.local.json'), 'utf8'),
      '{"fixture":true}\n',
    )
  }
  fs.writeFileSync(path.join(workspaceA.dir, 'hire/answer.txt'), 'task A hire\n')
  fs.writeFileSync(path.join(workspaceA.dir, 'web/answer.txt'), 'task A web\n')
  fs.writeFileSync(path.join(workspaceA.dir, 'hire/.env'), 'CHILD_SETUP=changed\n')
  await prepareProjectWorkspace(root, parent, workspaceA.dir, 'project-A')
  assert.equal(
    fs.readFileSync(path.join(workspaceA.dir, 'hire/answer.txt'), 'utf8'),
    'task A hire\n',
  )
  assert.equal(
    fs.readFileSync(path.join(workspaceA.dir, 'hire/.env'), 'utf8'),
    'CHILD_SETUP=changed\n',
  )
  assert.equal(fs.readFileSync(path.join(workspaceB.dir, 'hire/answer.txt'), 'utf8'), 'before\n')
  assert.equal(fs.readFileSync(path.join(hire, 'answer.txt'), 'utf8'), 'new canonical revision\n')
  assert.equal(fs.readFileSync(path.join(parent, 'web/answer.txt'), 'utf8'), 'before\n')
  assert.notEqual(
    git(path.join(workspaceA.dir, 'hire'), 'symbolic-ref', 'HEAD'),
    git(path.join(workspaceB.dir, 'hire'), 'symbolic-ref', 'HEAD'),
  )
  git(path.join(workspaceA.dir, 'hire'), 'add', 'answer.txt')
  git(
    path.join(workspaceA.dir, 'hire'),
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Isolated service change',
  )
  const resumedCommit = git(path.join(workspaceA.dir, 'hire'), 'rev-parse', 'HEAD')
  await prepareProjectWorkspace(root, parent, workspaceA.dir, 'project-A')
  assert.equal(git(path.join(workspaceA.dir, 'hire'), 'rev-parse', 'HEAD'), resumedCommit)
  assert.equal(git(workspaceA.dir, 'rev-parse', 'HEAD:hire'), pinned)
  const occupied = isolationFor(parent, 'occupied')
  git(parent, 'worktree', 'add', '-b', occupied.name, occupied.dir, 'HEAD')
  fs.writeFileSync(path.join(occupied.dir, 'hire/keep.txt'), 'keep\n')
  await assert.rejects(
    () => prepareProjectWorkspace(root, parent, occupied.dir, 'occupied'),
    /contiene archivos/,
  )
  assert.equal(fs.readFileSync(path.join(occupied.dir, 'hire/keep.txt'), 'utf8'), 'keep\n')
  await assert.rejects(() => prepareProjectWorkspace(root, parent, parent, 'shared'), /aislado/)
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(
    () => prepareProjectWorkspace(root, parent, workspaceA.dir, 'project-A', aborted.signal),
    /abort/i,
  )
  console.log(
    '  OK project inheritance, nested modules, independent boundaries, pinned isolated branches, setup files and safe reuse',
  )

  const store = new Store(':memory:')
  const config = ConfigSchema.parse({
    auth: { mode: 'indie' },
    repos: { path: root, default_repo: 'parent/hire' },
    slack: { workspace_team_id: 'T1', allowed_users: ['U1'] },
  })
  fs.writeFileSync(path.join(parent, '.env'), 'PROJECT_ONLY=parent\n')
  fs.writeFileSync(path.join(independent, '.env'), 'INDEPENDENT_ONLY=independent\n')
  const starts = [],
    finish = []
  const core = new Core({
    store,
    config,
    cwd: root,
    output: { async notice() {}, async status() {}, async delta() {}, async finish() {} },
    runner: (options) => {
      starts.push(options)
      const isolated = isolationFor(options.cwd, 'project-session')
      if (!fs.existsSync(isolated.dir))
        git(options.cwd, 'worktree', 'add', '-b', isolated.name, isolated.dir, 'HEAD')
      options.onEvent({ kind: 'init', sessionId: options.sessionId ?? `fixture-${starts.length}` })
      let resolve
      const done = new Promise((complete) => {
        resolve = complete
      })
      const complete = () =>
        resolve({ state: 'completed', text: 'done', error: '', cost: 0, usage: {} })
      finish.push(complete)
      return { done, cancel: complete }
    },
  })
  const wait = async (predicate) => {
    const deadline = Date.now() + 5000
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Project test timed out')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  try {
    const input = {
      adapter: 'slack',
      key: 'project-session',
      eventId: 'first',
      team: 'T1',
      channel: 'C1',
      author: 'U1',
      text: 'Review backend',
      repo: hire,
    }
    await core.submit(input)
    await wait(() => starts.length === 1)
    const active = [...core.active.values()][0]
    const isolated = isolationFor(parent, input.key)
    assert.equal(starts[0].cwd, parent)
    assert.equal(starts[0].env.PROJECT_ONLY, 'parent')
    assert.deepEqual(
      await Promise.all([core.prepareWorkspace(active.token), core.prepareWorkspace(active.token)]),
      [null, null],
    )
    assert.equal(
      store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='project_workspace'").get().n,
      1,
    )
    assert.equal(
      core.permission(active.token, {
        tool_name: 'Read',
        tool_input: { file_path: 'hire/answer.txt' },
        cwd: isolated.dir,
      }),
      null,
    )
    assert.equal(
      core.permission(active.token, {
        tool_name: 'Edit',
        tool_input: { file_path: 'answer.txt' },
        cwd: path.join(isolated.dir, 'hire'),
      }),
      null,
    )
    assert.equal(
      core.permission(active.token, {
        tool_name: 'Edit',
        tool_input: { file_path: 'answer.txt' },
        cwd: path.join(isolated.dir, 'web'),
      }),
      null,
    )
    assert.ok(
      core.permission(active.token, {
        tool_name: 'Write',
        tool_input: { file_path: 'unavailable/new.txt' },
        cwd: isolated.dir,
      }),
    )
    assert.ok(
      core.permission(active.token, {
        tool_name: 'Write',
        tool_input: { file_path: path.join(hire, 'answer.txt') },
        cwd: isolated.dir,
      }),
    )
    const selected = await core.tool(active.token, 'regent_use_repo', {
      repo: path.join(isolated.dir, 'web'),
      handoff: 'Continue frontend',
    })
    assert.equal(selected.unchanged, true)
    assert.equal(selected.cwd, path.join(isolated.dir, 'web'))
    assert.equal(store.conversation(input.key).session_id, 'fixture-1')
    await core.submit({
      ...input,
      eventId: 'second',
      text: 'Update frontend',
      repo: path.join(parent, 'web'),
    })
    finish[0]()
    await wait(() => starts.length === 2)
    assert.equal(starts[1].sessionId, 'fixture-1')
    assert.equal(starts[1].worktreeName, starts[0].worktreeName)
    assert.doesNotMatch(starts[1].prompt, /Antes de ejecutar la solicitud, llama regent_use_repo/)
    const next = [...core.active.values()][0]
    await core.tool(next.token, 'regent_use_repo', {
      repo: independent,
      handoff: 'Work on independent project',
    })
    await wait(() => starts.length === 3)
    assert.equal(starts[2].cwd, independent)
    assert.equal(starts[2].sessionId, null)
    assert.equal(starts[2].env.PROJECT_ONLY, undefined)
    assert.equal(starts[2].env.INDEPENDENT_ONLY, 'independent')
    console.log(
      '  OK shared root environment/session across submodules, scoped edits, and independent project handoff',
    )
  } finally {
    await core.close()
    store.close()
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
