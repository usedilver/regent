/**
 * Rama base: develop manda si existe; los repos chicos que solo tienen main caen
 * a su default; el override por repo gana sobre todo. Repos git de verdad.
 */
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

let failed = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`) } catch (err) { failed++; console.error(`  ✗ ${name}: ${err.message}`) }
}
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

/** clon real con las ramas pedidas en su "remoto" */
function makeRepo(name, branches, head) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-'))
  const origin = path.join(root, 'origin'), clone = path.join(root, name)
  fs.mkdirSync(origin)
  execFileSync('git', ['init', '-q', '-b', branches[0], origin], { stdio: 'ignore' })
  git(origin, 'config', 'user.email', 't@t'); git(origin, 'config', 'user.name', 't')
  fs.writeFileSync(path.join(origin, 'f'), 'x'); git(origin, 'add', '.'); git(origin, 'commit', '-qm', 'i')
  for (const b of branches.slice(1)) git(origin, 'branch', b)
  execFileSync('git', ['clone', '-q', origin, clone], { stdio: 'ignore' })
  git(clone, 'fetch', '-q', 'origin')
  git(clone, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${head}`)
  return { clone, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

// misma lógica que resolveBaseBranch en launcher.ts
function resolveBaseBranch(repoPath, cfg) {
  const exists = ref => { try { git(repoPath, 'rev-parse', '--verify', '--quiet', `origin/${ref}`); return true } catch { return false } }
  const override = cfg.repo_base_branches?.[path.basename(repoPath)]
  if (override) return override
  if (cfg.default_base_branch && exists(cfg.default_base_branch)) return cfg.default_base_branch
  try {
    const head = git(repoPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').trim().replace(/^origin\//, '')
    if (head) return head
  } catch { /* */ }
  return git(repoPath, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
}
const cfg = { default_base_branch: 'develop', repo_base_branches: {} }

console.log('base-branch:')

check('el caso Talently: origin/HEAD=master pero existe develop → develop', () => {
  const r = makeRepo('frontend-hire', ['master', 'develop'], 'master')
  assert.equal(resolveBaseBranch(r.clone, cfg), 'develop')
  r.cleanup()
})

check('repo chico sin develop → su rama default', () => {
  const r = makeRepo('tiny-tool', ['main'], 'main')
  assert.equal(resolveBaseBranch(r.clone, cfg), 'main')
  r.cleanup()
})

check('override por repo gana sobre develop', () => {
  const r = makeRepo('legacy', ['master', 'develop'], 'master')
  assert.equal(resolveBaseBranch(r.clone, { ...cfg, repo_base_branches: { legacy: 'master' } }), 'master')
  r.cleanup()
})

check('default_base_branch null = respetar siempre el default del repo', () => {
  const r = makeRepo('frontend-web', ['master', 'develop'], 'master')
  assert.equal(resolveBaseBranch(r.clone, { default_base_branch: null, repo_base_branches: {} }), 'master')
  r.cleanup()
})

if (failed) { console.error(`\n${failed} fallaron`); process.exit(1) }
