import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Core } from '../src/core.ts'
import { Store } from '../src/store.ts'
import { ConfigSchema } from '../src/config.ts'
import { resolveRepository, isolationFor } from '../src/repository.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'regent-projects-'))
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
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
    const config = ConfigSchema.parse({ permission_mode, auth: { mode: 'indie' },
      repos: { path: root, default_repo: 'repo' },
      slack: { workspace_team_id: 'T1', allowed_users: ['U1'] } })
    let options
    const core = new Core({ store, config, cwd: root,
      output: { async notice() {}, async status() {}, async delta() {}, async finish() {} },
      runner: value => {
        options = value
        const isolated = { name: value.worktreeName, dir: path.join(repo, '.claude/worktrees', value.worktreeName) }
        if (!fs.existsSync(isolated.dir)) git(repo, 'worktree', 'add', '-b', `worktree-${isolated.name}`, isolated.dir, 'HEAD')
        let finish
        return { done: new Promise(resolve => { finish = resolve }),
          cancel: () => finish({ state: 'interrupted', text: '', error: 'stopped', cost: 0, usage: {} }) }
      } })
    try {
      const key = 'slack:C1:1'
      await core.submit({ adapter: 'slack', key, eventId: 'edit', author: 'U1', channel: 'C1', thread: '1', team: 'T1', text: 'Change the text' })
      const active = [...core.active.values()][0]
      const permit = (tool_name, tool_input) => core.permission(active.token, { tool_name, tool_input })
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
        assert.ok(permit(tool_name, { [field]: '.env' }))
      }
      assert.equal(permit('Write', { file_path: '.claude/settings.json' }), null)
      assert.equal(permit('Write', { file_path: '.mcp.json' }), null)
      assert.ok(permit('Write', { file_path: path.join(repo, 'secret-alias') }))
      assert.ok(permit('Write', { file_path: path.join(repo, 'broken-link') }))
      for (const command of ['git add answer.txt', 'git commit -m fix', 'gh pr create', 'pnpm test', 'ncard create task']) {
        assert.equal(permit('Bash', { command }), null)
      }
      // Simulate the runtime using the approved repository tools, not core helpers.
      fs.writeFileSync(path.join(isolated.dir, 'answer.txt'), `${permission_mode}\n`)
      assert.match(git(isolated.dir, 'diff', '--', 'answer.txt'), new RegExp(permission_mode))
      git(isolated.dir, 'add', 'answer.txt')
      git(isolated.dir, 'commit', '-m', `Edit with ${permission_mode}`)
      const other = isolationFor(repo, 'slack:C2:2')
      await core.submit({ adapter: 'slack', key: 'slack:C2:2', eventId: 'second', author: 'U1', channel: 'C2', thread: '2', team: 'T1', text: 'Another fix' })
      assert.equal(core.active.size, 2)
      const otherToken = core.active.get('slack:C2:2').token
      assert.equal(core.permission(otherToken, { tool_name: 'Write', tool_input: { file_path: path.join(other.dir, 'answer.txt') }, cwd: other.dir }), null)
      assert.ok(core.permission(otherToken, { tool_name: 'Write', tool_input: { file_path: path.join(isolated.dir, 'answer.txt') }, cwd: other.dir }))
      fs.writeFileSync(path.join(other.dir, 'answer.txt'), 'independent\n')
      assert.ok(permit('Write', { file_path: path.join(other.dir, 'answer.txt') }))
      assert.ok(core.permission(active.token, { tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: repo }))
      assert.ok(core.permission(active.token, { tool_name: 'ExitWorktree', tool_input: {} }))
      assert.equal(fs.readFileSync(path.join(repo, 'answer.txt'), 'utf8'), 'before\n')
      assert.equal(fs.readFileSync(path.join(isolated.dir, 'answer.txt'), 'utf8'), `${permission_mode}\n`)
      assert.notEqual(git(isolated.dir, 'symbolic-ref', 'HEAD'), git(other.dir, 'symbolic-ref', 'HEAD'))
      assert.equal(isolationFor(repo, key).dir, isolated.dir)
      for (const table of ['tasks', 'task_gates', 'worktrees', 'prs']) {
        assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0)
      }
      assert.ok(core.permission('expired', { tool_name: 'Edit', tool_input: { file_path: 'answer.txt' } }))
      await core.tool(active.token, 'regent_ask_human', { question: 'Publish?', options: ['Yes', 'No'] })
      assert.ok(permit('Write', { file_path: 'answer.txt' }))
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM gates').get().n, 1)
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM task_gates').get().n, 0)
      console.log(`  OK ${permission_mode}: edits and commits without tasks, legacy policy ignored, conversational questions retained`)
    } finally { await core.close(); store.close() }
  }
  for (const name of ['plan', 'implement', 'qa']) {
    assert.ok(!fs.existsSync(path.resolve('plugin/skills', name, 'SKILL.md')))
  }
  const parent = path.join(root, 'parent')
  git(root, 'init', parent)
  git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', repo, 'hire')
  const hire = path.join(parent, 'hire')
  const a = isolationFor(hire, 'thread-A'), b = isolationFor(hire, 'thread-B')
  git(hire, 'worktree', 'add', '-b', a.name, a.dir, 'HEAD')
  git(hire, 'worktree', 'add', '-b', b.name, b.dir, 'HEAD')
  fs.writeFileSync(path.join(a.dir, 'answer.txt'), 'fix A')
  fs.writeFileSync(path.join(b.dir, 'answer.txt'), 'fix B')
  assert.equal(fs.readFileSync(path.join(hire, 'answer.txt'), 'utf8'), 'before\n')
  assert.equal(fs.readFileSync(path.join(a.dir, 'answer.txt'), 'utf8'), 'fix A')
  assert.equal(fs.readFileSync(path.join(b.dir, 'answer.txt'), 'utf8'), 'fix B')
  assert.notEqual(git(a.dir, 'symbolic-ref', 'HEAD'), git(b.dir, 'symbolic-ref', 'HEAD'))
  console.log('  OK two isolated worktrees of a submodule leave its shared checkout untouched')
} finally { fs.rmSync(root, { recursive: true, force: true }) }
