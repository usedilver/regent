import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { publishGitBranch } from '../src/core/git-publication.ts'
import { denial } from '../plugins/executor/hooks/policy.mjs'

const git = (directory, ...args) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim()

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-publish-')))
  const remote = path.join(root, 'remote.git')
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  git(root, 'init', '--bare', remote)
  git(root, '--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  git(repo, 'init', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'file'), 'base')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'Base')
  git(repo, 'remote', 'add', 'origin', remote)
  git(repo, 'push', '-u', 'origin', 'main')
  git(repo, 'switch', '-c', 'work')
  fs.appendFileSync(path.join(repo, 'file'), '\nfirst')
  git(repo, 'commit', '-am', 'First change')
  const first = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'push', 'origin', 'work', 'HEAD:refs/pull/9/head')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return {
    repo,
    remote,
    first,
    tip: (branch) => git(repo, 'ls-remote', 'origin', `refs/heads/${branch}`).split(/\s+/)[0],
    next() {
      fs.appendFileSync(path.join(repo, 'file'), '\nsecond')
      git(repo, 'commit', '-am', 'Second change')
      return git(repo, 'rev-parse', 'HEAD')
    },
  }
}

test('a commit made after its PR merged must be published on a new branch', async (t) => {
  const f = fixture(t)
  const second = f.next()
  const merged = async () => [{ number: 9, state: 'MERGED', headRefOid: f.first }]
  await assert.rejects(publishGitBranch(f.repo, 'push', 'work', undefined, merged), /rama nueva/)
  assert.equal(f.tip('work'), f.first)
  const saved = await publishGitBranch(f.repo, 'push', 'recovery', undefined, async () => [])
  assert.equal(saved.commit, second)
  assert.equal(f.tip('recovery'), second)
})

test('branch deletion protects a later commit missing from the merged PR, then permits verified recovery', async (t) => {
  const f = fixture(t)
  const second = f.next()
  git(f.repo, 'push', 'origin', 'work')
  const merged = async () => [{ number: 9, state: 'MERGED', headRefOid: f.first }]
  await assert.rejects(
    publishGitBranch(f.repo, 'delete_branch', 'work', undefined, merged),
    /sin otro respaldo/,
  )
  assert.equal(f.tip('work'), second)
  await publishGitBranch(f.repo, 'push', 'recovery', undefined, async () => [])
  const removed = await publishGitBranch(f.repo, 'delete_branch', 'work', undefined, merged)
  assert.equal(removed.state, 'deleted')
  assert.equal(f.tip('work'), '')
  assert.equal(f.tip('recovery'), second)
})

test('a closed PR ref preserves the exact tip after branch deletion', async (t) => {
  const f = fixture(t)
  const result = await publishGitBranch(f.repo, 'delete_branch', 'work', undefined, async () => [
    { number: 9, state: 'CLOSED', headRefOid: f.first },
  ])
  assert.equal(result.state, 'deleted')
  assert.equal(git(f.repo, 'rev-parse', 'refs/regent/publication/pr-9'), f.first)
})

test('open PRs and the default branch are protected against deletion', async (t) => {
  const f = fixture(t)
  await assert.rejects(
    publishGitBranch(f.repo, 'delete_branch', 'work', undefined, async () => [
      { number: 9, state: 'OPEN', headRefOid: f.first },
    ]),
    /sigue abierto/,
  )
  await assert.rejects(
    publishGitBranch(f.repo, 'delete_branch', 'main', undefined, async () => []),
    /predeterminada/,
  )
})

test('a PR closing during push is reported explicitly without claiming it contains the commit', async (t) => {
  const f = fixture(t)
  const second = f.next()
  let calls = 0
  const result = await publishGitBranch(f.repo, 'push', 'work', undefined, async () => [
    { number: 9, state: ++calls === 1 ? 'OPEN' : 'MERGED', headRefOid: f.first },
  ])
  assert.equal(result.state, 'pushed_after_close')
  assert.equal(f.tip('work'), second)
  assert.match(result.instruction, /new PR/)
})

test('stale GitHub head and unavailable PR status never count as verified publication', async (t) => {
  const f = fixture(t)
  f.next()
  const result = await publishGitBranch(f.repo, 'push', 'work', undefined, async () => [
    { number: 9, state: 'OPEN', headRefOid: f.first },
  ])
  assert.equal(result.pull_request_verified, false)
  const before = f.tip('work')
  await assert.rejects(
    publishGitBranch(f.repo, 'push', 'work', undefined, async () => {
      throw new Error('lookup failed')
    }),
    /lookup failed/,
  )
  assert.equal(f.tip('work'), before)
})

test('a PR opened concurrently with publication must also confirm the pushed head', async (t) => {
  const f = fixture(t)
  f.next()
  let calls = 0
  const result = await publishGitBranch(f.repo, 'push', 'work', undefined, async () =>
    ++calls === 1 ? [] : [{ number: 10, state: 'OPEN', headRefOid: f.first }],
  )
  assert.equal(result.pull_request_verified, false)
})

test('shell publication and branch deletion must use the guarded core tool', () => {
  for (const command of [
    'git push',
    'git -C /tmp/repo push origin work',
    'git push origin --delete work',
    'gh pr merge 9 --delete-branch',
    'gh pr close 9 --delete-branch',
    'gh api -X DELETE repos/owner/repo/git/refs/heads/work',
  ]) {
    assert.match(denial({ tool_name: 'Bash', tool_input: { command } }, {}), /regent_git_publish/)
  }
  assert.equal(denial({ tool_name: 'Bash', tool_input: { command: 'gh pr view 9' } }, {}), null)
})
