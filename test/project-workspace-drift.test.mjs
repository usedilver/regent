import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ConfigSchema } from '../src/config.ts'
import { Core } from '../src/core/core.ts'
import { isolationFor } from '../src/core/repository.ts'
import { prepareSubmodule, scanProjectWorkspace } from '../src/core/project-workspace.ts'
import { Store } from '../src/storage/store.ts'

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

function fixture(t, { nested = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-drift-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = path.join(root, 'project')
  const child = path.join(root, 'child')

  for (const directory of [repo, child]) {
    git(root, 'init', '-b', 'main', directory)
    fs.writeFileSync(path.join(directory, '.gitignore'), '.claude/worktrees/\n')
    fs.writeFileSync(path.join(directory, 'file.txt'), 'original\n')
    git(directory, 'add', '.')
    git(directory, 'commit', '-m', 'Initial fixture')
  }

  if (nested) {
    git(child, 'submodule', 'add', repo, 'nested')
    git(child, 'commit', '-am', 'Register a nested service')
  }

  const relative = 'services/child'
  const name = 'retired.module'
  git(repo, 'submodule', 'add', '--name', name, child, relative)
  git(repo, 'submodule', 'add', child, 'sibling')
  if (nested) git(path.join(repo, relative), 'submodule', 'update', '--init')
  git(repo, 'commit', '-am', 'Register services')
  const key = 'slack:C1:fixture'
  const isolated = isolationFor(repo, key).dir
  git(repo, 'worktree', 'add', '-b', 'conversation', isolated)
  const baseline = git(isolated, 'rev-parse', 'HEAD')
  const pinned = git(isolated, 'rev-parse', `HEAD:${relative}`)

  const retire = () => {
    git(repo, 'rm', '--cached', relative)
    git(repo, 'config', '-f', '.gitmodules', '--remove-section', `submodule.${name}`)
    git(repo, 'commit', '-am', 'Retire a service in the shared checkout')
  }

  return { root, repo, child, relative, name, key, isolated, baseline, pinned, retire }
}

function runtime(t, f) {
  const store = new Store(':memory:')
  const starts = []
  const core = new Core({
    store,
    cwd: f.root,
    config: ConfigSchema.parse({
      auth: { mode: 'indie' },
      repos: { path: f.root, default_repo: 'project' },
      slack: { workspace_team_id: 'T1', allowed_users: ['U1'] },
    }),
    output: { async notice() {}, async status() {}, async delta() {}, async finish() {} },
    runner: (options) => {
      starts.push(options)
      options.onEvent({ kind: 'init', sessionId: options.sessionId ?? 'fixture-session' })
      let complete
      const done = new Promise((resolve) => {
        complete = () =>
          resolve({ state: 'completed', text: 'done', error: '', cost: 0, usage: {} })
      })
      return { done, cancel: complete }
    },
  })
  t.after(async () => {
    await core.close()
    store.close()
  })

  const submit = (eventId, intent) =>
    core.submit({
      adapter: 'slack',
      key: f.key,
      eventId,
      team: 'T1',
      channel: 'C1',
      thread: 'fixture',
      author: 'U1',
      intent,
      text: 'Continue the existing task',
    })

  return { core, store, starts, submit }
}

test('retiring a source submodule preserves the old worktree inventory and pinned preparation', async (t) => {
  const f = fixture(t)
  f.retire()
  const status = git(f.repo, 'status', '--porcelain')

  assert.deepEqual(await scanProjectWorkspace(f.root, f.repo, f.isolated, 'refresh'), {
    submodules: [],
    unavailable: [],
    pending: [f.relative, 'sibling'],
  })
  assert.deepEqual(await prepareSubmodule(f.root, f.repo, f.isolated, f.key, f.relative), [
    f.relative,
  ])
  assert.equal(git(path.join(f.isolated, f.relative), 'rev-parse', 'HEAD'), f.pinned)
  assert.equal(git(f.isolated, 'rev-parse', 'HEAD'), f.baseline)
  assert.equal(git(f.repo, 'status', '--porcelain'), status)
  const latest = isolationFor(f.repo, 'new-conversation').dir
  git(f.repo, 'worktree', 'add', '-b', 'latest-conversation', latest)
  assert.deepEqual(await scanProjectWorkspace(f.root, f.repo, latest, 'read'), {
    submodules: [],
    unavailable: [],
    pending: ['sibling'],
  })
})

test('an active turn and its resumed session can select a retired submodule without resetting', async (t) => {
  const f = fixture(t)
  const r = runtime(t, f)
  await r.submit('first')
  const first = r.core.active.get(f.key)
  f.retire()

  assert.equal(await r.core.prepareWorkspace(first.token, 'Bash'), null)
  assert.equal(
    r.core.permission(first.token, {
      tool_name: 'Bash',
      tool_input: { command: 'echo ok' },
      cwd: f.isolated,
    }),
    null,
  )
  const selected = await r.core.tool(first.token, 'regent_use_repo', {
    repo: f.relative,
    handoff: 'Continue in the existing service',
  })
  assert.equal(selected.cwd, path.join(f.isolated, f.relative))
  assert.equal(selected.unchanged, true)
  await first.controller.cancel()
  await first.done
  await r.submit('resume')
  const resumed = r.core.active.get(f.key)
  assert.equal(r.starts[1].sessionId, 'fixture-session')
  assert.equal(await r.core.prepareWorkspace(resumed.token, 'Bash'), null)
  assert.equal(git(f.isolated, 'rev-parse', 'HEAD'), f.baseline)
})

test('an initialized submodule keeps its files and identity after the shared checkout is removed', async (t) => {
  const f = fixture(t)
  await prepareSubmodule(f.root, f.repo, f.isolated, f.key, f.relative)
  const checkout = path.join(f.isolated, f.relative)
  fs.writeFileSync(path.join(checkout, 'file.txt'), 'work in progress\n')
  f.retire()
  fs.rmSync(path.join(f.repo, f.relative), { recursive: true, force: true })

  const inventory = await scanProjectWorkspace(f.root, f.repo, f.isolated, 'refresh')
  assert.deepEqual(inventory.submodules, [f.relative])
  assert.deepEqual(inventory.unavailable, [])
  assert.equal(fs.readFileSync(path.join(checkout, 'file.txt'), 'utf8'), 'work in progress\n')
  const r = runtime(t, f)
  await r.submit('existing-checkout')
  const active = r.core.active.get(f.key)
  const selected = await r.core.tool(active.token, 'regent_use_repo', {
    repo: f.relative,
    handoff: 'Preserve the existing checkout and local work',
  })
  assert.equal(selected.cwd, checkout)
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), f.pinned)
  await active.controller.cancel()
  await active.done
  await r.submit('query-checkout', 'ask')
  const query = r.core.active.get(f.key)
  const readOnly = await r.core.tool(query.token, 'regent_use_repo', {
    repo: checkout,
    handoff: 'Read the existing isolated checkout',
  })
  assert.equal(query.readOnly, true)
  assert.equal(readOnly.cwd, checkout)
  assert.equal(r.starts[1].sessionId, 'fixture-session')
})

test('an unrelated replacement at a retired path stays unavailable without blocking root commands', async (t) => {
  const f = fixture(t)
  f.retire()
  const replacement = path.join(f.repo, f.relative)
  fs.rmSync(replacement, { recursive: true, force: true })
  git(f.root, 'clone', f.child, replacement)
  const r = runtime(t, f)
  await r.submit('replacement')
  const active = r.core.active.get(f.key)

  assert.equal(await r.core.prepareWorkspace(active.token, 'Bash'), null)
  assert.deepEqual(active.workspace.unavailable, [f.relative])
  assert.equal(
    r.core.permission(active.token, {
      tool_name: 'Bash',
      tool_input: { command: 'true' },
      cwd: f.isolated,
    }),
    null,
  )
  assert.match(
    r.core.permission(active.token, {
      tool_name: 'Write',
      tool_input: { file_path: `${f.relative}/file.txt` },
      cwd: f.isolated,
    }),
    /submodulo no esta inicializado/,
  )
  await assert.rejects(
    r.core.tool(active.token, 'regent_use_repo', {
      repo: f.relative,
      handoff: 'This independent replacement must not become part of the conversation',
    }),
    /otro proyecto/,
  )
  assert.ok(!fs.existsSync(path.join(f.isolated, f.relative, '.git')))
})

test('a pending nested submodule can be selected after its enclosing source module is retired', async (t) => {
  const f = fixture(t, { nested: true })
  f.retire()
  const r = runtime(t, f)
  await r.submit('pending-nested')
  const active = r.core.active.get(f.key)
  const relative = `${f.relative}/nested`
  const selected = await r.core.tool(active.token, 'regent_use_repo', {
    repo: relative,
    handoff: 'Prepare the pinned enclosing and nested service',
  })
  assert.equal(selected.cwd, path.join(f.isolated, relative))
  assert.deepEqual(selected.prepared, [f.relative, relative])
})

test('initialized nested submodules survive retirement and removal of their source checkouts', async (t) => {
  const f = fixture(t, { nested: true })
  const relative = `${f.relative}/nested`
  await prepareSubmodule(f.root, f.repo, f.isolated, f.key, relative)
  f.retire()
  fs.rmSync(path.join(f.repo, f.relative), { recursive: true, force: true })
  const inventory = await scanProjectWorkspace(f.root, f.repo, f.isolated, 'refresh')
  assert.deepEqual(inventory.submodules, [f.relative, relative])
  assert.deepEqual(inventory.unavailable, [])
  const r = runtime(t, f)
  await r.submit('nested')
  const active = r.core.active.get(f.key)
  const selected = await r.core.tool(active.token, 'regent_use_repo', {
    repo: relative,
    handoff: 'Continue in the isolated nested service',
  })
  assert.equal(selected.cwd, path.join(f.isolated, relative))
  assert.equal(selected.unchanged, true)
})

test('a foreign checkout or symlink cannot replace an isolated registered submodule', async (t) => {
  const f = fixture(t)
  f.retire()
  const destination = path.join(f.isolated, f.relative)
  fs.rmdirSync(destination)
  git(f.child, 'worktree', 'add', '--detach', destination)
  await assert.rejects(
    scanProjectWorkspace(f.root, f.repo, f.isolated, 'refresh'),
    /no corresponde al repositorio/,
  )
  git(f.child, 'worktree', 'remove', destination)
  fs.symlinkSync(path.join(f.repo, f.relative), destination)
  await assert.rejects(
    scanProjectWorkspace(f.root, f.repo, f.isolated, 'refresh'),
    /no corresponde al repositorio/,
  )
})

test('workspace preparation can retry after a transient failure within the same turn', async (t) => {
  const f = fixture(t)
  const r = runtime(t, f)
  await r.submit('retry')
  const active = r.core.active.get(f.key)
  const modules = path.join(f.isolated, '.gitmodules')
  const original = fs.readFileSync(modules)
  fs.writeFileSync(modules, '[invalid\n')
  const errors = await Promise.all([
    r.core.prepareWorkspace(active.token, 'Bash'),
    r.core.prepareWorkspace(active.token, 'Read'),
  ])
  for (const error of errors) assert.match(error, /No se pudo preparar/)
  fs.writeFileSync(modules, original)
  assert.equal(await r.core.prepareWorkspace(active.token, 'Bash'), null)
  assert.equal(r.store.conversation(f.key).session_id, 'fixture-session')
})
