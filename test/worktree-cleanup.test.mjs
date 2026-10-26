import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { isolationFor } from '../src/core/repository.ts'
import { removeConversationWorktree, cleanupPlan } from '../src/core/worktree-cleanup.ts'
import { prepareProjectWorkspace } from '../src/core/project-workspace.ts'
import { Store } from '../src/storage/store.ts'
import { Core } from '../src/core/core.ts'
import { ConfigSchema } from '../src/config.ts'
import { executionContext } from '../src/core/execution-context.ts'

const git = (cwd, ...args) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'protocol.file.allow=always',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim()

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-cleanup-')))
  const repo = path.join(root, 'repo')
  const remote = path.join(root, 'remote.git')
  fs.mkdirSync(repo)
  git(root, 'init', '--bare', remote)
  git(repo, 'init', '-b', 'main')
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/worktrees/\n.env\n')
  fs.writeFileSync(path.join(repo, 'file.txt'), 'original\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'Fixture')
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'push', '-u', 'origin', 'main')
  const key = 'mcp:fixture:cleanup'
  const isolated = isolationFor(repo, key).dir
  git(repo, 'worktree', 'add', '-b', 'conversation', isolated)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, repo, remote, key, isolated }
}

test('explicit cleanup removes only its registered worktree, preserves source/branches and is idempotent', async (t) => {
  const f = fixture(t)
  const sibling = path.join(f.root, 'sibling')
  git(f.repo, 'worktree', 'add', '-b', 'sibling', sibling)
  fs.writeFileSync(path.join(f.isolated, '.env'), 'FIXTURE=ignored-copy\n')
  let stops = 0
  const result = await removeConversationWorktree(f.repo, f.key, () => stops++)
  assert.equal(result.state, 'removed')
  assert.equal(stops, 1)
  assert.ok(!fs.existsSync(f.isolated))
  assert.ok(fs.existsSync(sibling))
  assert.equal(fs.readFileSync(path.join(f.repo, 'file.txt'), 'utf8'), 'original\n')
  assert.equal(git(f.repo, 'show', 'conversation:file.txt'), 'original')
  assert.equal((await removeConversationWorktree(f.repo, f.key, () => stops++)).state, 'absent')
  assert.equal(stops, 2)
})

test('tracked, untracked and unpublished changes block before stopping preview or deleting files', async (t) => {
  const f = fixture(t)
  let stops = 0
  fs.writeFileSync(path.join(f.isolated, 'untracked.txt'), 'keep')
  await assert.rejects(
    removeConversationWorktree(f.repo, f.key, () => stops++),
    /sin commit/,
  )
  fs.rmSync(path.join(f.isolated, 'untracked.txt'))
  fs.appendFileSync(path.join(f.isolated, 'file.txt'), 'local\n')
  await assert.rejects(
    removeConversationWorktree(f.repo, f.key, () => stops++),
    /sin commit/,
  )
  git(f.isolated, 'add', 'file.txt')
  git(f.isolated, 'commit', '-m', 'Local work')
  await assert.rejects(
    removeConversationWorktree(f.repo, f.key, () => stops++),
    /sin respaldo/,
  )
  assert.equal(stops, 0)
  assert.ok(fs.existsSync(f.isolated))
})

test('an explicitly identified remote PR ref protects squash-merged work after source branch deletion', async (t) => {
  const f = fixture(t)
  fs.appendFileSync(path.join(f.isolated, 'file.txt'), 'pr work\n')
  git(f.isolated, 'commit', '-am', 'PR work')
  git(f.isolated, 'push', 'origin', 'HEAD:refs/pull/9/head')
  const result = await removeConversationWorktree(f.repo, f.key, () => {}, [
    { directory: '.', number: 9 },
  ])
  assert.equal(result.state, 'removed')
  assert.equal(git(f.repo, 'show', 'refs/regent/cleanup/pr-9:file.txt'), 'original\npr work')
})

test('manual locks and symlinks fail closed; a recognized stale native lock can be released', async (t) => {
  const f = fixture(t)
  git(f.repo, 'worktree', 'lock', '--reason', 'manual maintenance', f.isolated)
  await assert.rejects(
    removeConversationWorktree(f.repo, f.key, () => {}),
    /bloqueo manual/,
  )
  git(f.repo, 'worktree', 'unlock', f.isolated)
  git(
    f.repo,
    'worktree',
    'lock',
    '--reason',
    `claude session ${isolationFor(f.repo, f.key).name} (pid 99999999 start 1)`,
    f.isolated,
  )
  assert.equal((await removeConversationWorktree(f.repo, f.key, () => {})).state, 'removed')
  fs.symlinkSync(f.repo, f.isolated)
  await assert.rejects(cleanupPlan(f.repo, f.key), /enlace simbolico/)
})

test('registered submodule and nested preview checkouts are removed before their parent', async (t) => {
  const f = fixture(t)
  const child = path.join(f.root, 'child')
  fs.mkdirSync(child)
  git(child, 'init', '-b', 'main')
  fs.writeFileSync(path.join(child, 'child.txt'), 'child')
  git(child, 'add', '.')
  git(child, 'commit', '-m', 'Child')
  git(f.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'services/child')
  git(f.repo, 'commit', '-am', 'Register child')
  git(f.repo, 'push')
  git(f.isolated, 'merge', '--ff-only', 'main')
  await prepareProjectWorkspace(f.root, f.repo, f.isolated, f.key)
  const extra = path.join(f.isolated, '.claude/worktrees/preview')
  git(path.join(f.repo, 'services/child'), 'worktree', 'add', '--detach', extra)
  const result = await removeConversationWorktree(f.repo, f.key, () => {})
  assert.equal(result.state, 'removed')
  assert.equal(result.removed.length, 3)
  assert.equal(result.removed.at(-1), f.isolated)
  assert.ok(
    !git(path.join(f.repo, 'services/child'), 'worktree', 'list', '--porcelain').includes(
      f.isolated,
    ),
  )
})

test('unchanged pinned submodule history is retained locally even if origin rewrote it; new local work still blocks', async (t) => {
  const f = fixture(t)
  const child = path.join(f.root, 'child')
  fs.mkdirSync(child)
  git(child, 'init', '-b', 'main')
  fs.writeFileSync(path.join(child, 'child.txt'), 'baseline')
  git(child, 'add', '.')
  git(child, 'commit', '-m', 'Baseline')
  git(f.repo, 'submodule', 'add', child, 'child')
  git(f.repo, 'commit', '-am', 'Register child')
  git(f.repo, 'push')
  git(f.isolated, 'merge', '--ff-only', 'main')
  await prepareProjectWorkspace(f.root, f.repo, f.isolated, f.key)
  const isolatedChild = path.join(f.isolated, 'child')
  const baseline = git(isolatedChild, 'rev-parse', 'HEAD')
  fs.writeFileSync(path.join(isolatedChild, 'child.txt'), 'new local work')
  git(isolatedChild, 'commit', '-am', 'Unpublished work')
  await assert.rejects(
    removeConversationWorktree(f.repo, f.key, () => {}),
    /sin respaldo/,
  )
  git(isolatedChild, 'reset', '--hard', baseline)
  git(child, 'checkout', '--orphan', 'replacement')
  git(child, 'commit', '-m', 'Replacement history')
  git(child, 'branch', '-D', 'main')
  git(child, 'branch', '-m', 'main')
  const sourceChild = path.join(f.repo, 'child')
  git(sourceChild, 'fetch', '--prune', 'origin')
  assert.equal(
    git(
      sourceChild,
      'for-each-ref',
      '--format=%(refname)',
      '--contains',
      baseline,
      'refs/remotes/origin',
    ),
    '',
  )
  const result = await removeConversationWorktree(f.repo, f.key, () => {})
  assert.equal(result.state, 'removed')
  assert.ok(
    git(sourceChild, 'for-each-ref', '--format=%(refname)', '--contains', baseline, 'refs/heads'),
  )
  assert.equal(git(sourceChild, 'show', baseline + ':child.txt'), 'baseline')
})

test('core defers removal until executor exit, reports actual result, detaches session and permits fresh queries', async (t) => {
  for (const blocked of [false, true]) {
    const f = fixture(t)
    const store = new Store(':memory:')
    let finish
    const replies = []
    const core = new Core({
      store,
      cwd: f.root,
      config: ConfigSchema.parse({
        auth: { mode: 'indie' },
        repos: { path: f.root, default_repo: 'repo' },
        slack: { workspace_team_id: 'T', allowed_users: ['U'] },
      }),
      output: {
        async notice() {},
        async status() {},
        async delta() {},
        async finish(c, r, text) {
          replies.push(text)
        },
      },
      runner: () => ({
        done: new Promise((resolve) => {
          finish = () =>
            resolve({
              state: 'completed',
              text: 'PR #11 cerrado sin merge y rama remota eliminada. Limpieza del worktree solicitada.',
              error: '',
              cost: 0,
              usage: {},
            })
        }),
        cancel() {
          finish()
        },
      }),
    })
    t.after(async () => {
      await core.close()
      store.close()
    })
    const accepted = await core.submit({
      adapter: 'slack',
      author: 'U',
      team: 'T',
      channel: 'C',
      key: f.key,
      eventId: 'first',
      intent: 'task',
      text: 'Ya hice merge; elimina el worktree',
    })
    while (!finish) await new Promise((r) => setTimeout(r, 5))
    const active = core.active.get(f.key)
    store.session(f.key, 'fixture-session', f.isolated)
    await core.tool(active.token, 'regent_cleanup_worktree', {})
    assert.ok(fs.existsSync(f.isolated), 'must not remove while executor is running')
    await assert.rejects(
      core.tool(active.token, 'regent_git_read', { operation: 'status' }),
      /limpieza/,
    )
    if (blocked) fs.writeFileSync(path.join(f.isolated, 'uncommitted.txt'), 'keep local work')
    finish()
    await active.done
    assert.equal(
      store.lastEvent(accepted.runId, 'worktree_cleanup').state,
      blocked ? 'blocked' : 'removed',
    )
    assert.equal(store.conversation(f.key).session_id, blocked ? 'fixture-session' : null)
    assert.ok(
      replies
        .at(-1)
        .startsWith(
          blocked
            ? 'Limpieza del worktree pendiente:'
            : 'Worktree y checkouts anidados eliminados;',
        ),
    )
    assert.equal(fs.existsSync(f.isolated), blocked)
    assert.ok(replies.at(-1).includes('PR #11 cerrado sin merge y rama remota eliminada.'))
    assert.ok(store.run(accepted.runId).result.includes('PR #11 cerrado sin merge'))
    const next = executionContext(store.conversation(f.key), 'ask')
    assert.equal(next.directory, blocked ? f.isolated : f.repo)
    assert.equal(next.sessionId, blocked ? 'fixture-session' : null)
    assert.equal(store.run(accepted.runId).state, 'completed')
  }
})

test('merge alone, query mode and cancellation never trigger removal', async (t) => {
  for (const mode of ['merge-only', 'query', 'cancel']) {
    const f = fixture(t)
    const store = new Store(':memory:')
    let finish
    const core = new Core({
      store,
      cwd: f.root,
      config: ConfigSchema.parse({
        auth: { mode: 'indie' },
        repos: { path: f.root, default_repo: 'repo' },
        slack: { workspace_team_id: 'T', allowed_users: ['U'] },
      }),
      output: { async notice() {}, async status() {}, async delta() {}, async finish() {} },
      runner: () => ({
        done: new Promise((resolve) => {
          finish = () =>
            resolve({ state: 'completed', text: 'Acknowledged.', error: '', cost: 0, usage: {} })
        }),
        cancel() {
          finish()
        },
      }),
    })
    const accepted = await core.submit({
      adapter: 'slack',
      author: 'U',
      team: 'T',
      channel: 'C',
      key: f.key,
      eventId: 'first',
      intent: mode === 'query' ? 'ask' : 'task',
      text: mode === 'merge-only' ? 'Ya hice merge, no hagas nada' : 'Elimina el worktree',
    })
    while (!finish) await new Promise((r) => setTimeout(r, 5))
    const active = core.active.get(f.key)
    if (mode === 'query')
      await assert.rejects(core.tool(active.token, 'regent_cleanup_worktree', {}), /Query/)
    if (mode === 'cancel') {
      await core.tool(active.token, 'regent_cleanup_worktree', {})
      active.cancelled = true
    }
    finish()
    await active.done
    assert.ok(fs.existsSync(f.isolated))
    assert.equal(store.lastEvent(accepted.runId, 'worktree_cleanup'), undefined)
    await core.close()
    store.close()
  }
})
