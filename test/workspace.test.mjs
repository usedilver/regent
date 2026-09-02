/** Workspace por card: registro, worktree por repo (git real), PRs, limpieza y guard. */
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as W from '../src/workspace.ts'

let failed = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`) } catch (err) { failed++; console.error(`  ✗ ${name}: ${err.message}`) }
}
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

function makeRepo(name, branches, head) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'))
  const origin = path.join(root, 'origin.git'), clone = path.join(root, name)
  execFileSync('git', ['init', '-q', '-b', branches[0], origin], { stdio: 'ignore' })
  git(origin, 'config', 'user.email', 't@t'); git(origin, 'config', 'user.name', 't')
  fs.writeFileSync(path.join(origin, 'f'), 'x'); git(origin, 'add', '.'); git(origin, 'commit', '-qm', 'i')
  for (const b of branches.slice(1)) git(origin, 'branch', b)
  execFileSync('git', ['clone', '-q', '--single-branch', '-b', head, origin, clone], { stdio: 'ignore' })
  git(clone, 'config', 'user.email', 't@t'); git(clone, 'config', 'user.name', 't')
  return { root, clone, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}
const cfg = { default_base_branch: 'develop', repo_base_branches: {} }
const PAGE = '3ce95d7f-fd3c-8090-97f5-f3d98a97f5bb'

// aislar el registro y los worktrees del bridge real
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-bridge-'))
W.WORKSPACES_DIR !== undefined
const orig = { ws: W.WORKSPACES_DIR, wt: W.WORKTREES_DIR }

console.log('workspace:')

check('shortIdOf: últimos 12 del page id sin guiones', () => {
  assert.equal(W.shortIdOf(PAGE), 'f3d98a97f5bb')
})

check('registro: nuevo → guardar → cargar', () => {
  const reg = W.newRegistry(PAGE, '/tmp/root')
  assert.deepEqual(reg.repos, {})
  W.saveRegistry(reg)
  assert.deepEqual(W.loadRegistry('f3d98a97f5bb'), reg)
  fs.rmSync(W.registryPath('f3d98a97f5bb'))
})

check('addWorktree: clon single-branch en master, existe develop → rama desde develop', () => {
  const r = makeRepo('frontend-hire', ['master', 'develop'], 'master')
  const reg = W.newRegistry(PAGE, r.root)
  const e = W.addWorktree(reg, r.clone, cfg)
  assert.equal(e.base, 'develop')
  assert.equal(e.branch, 'agent/f3d98a97f5bb')
  assert.equal(git(e.dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'agent/f3d98a97f5bb')
  assert.ok(fs.existsSync(path.join(e.dir, 'f')))
  assert.equal(path.basename(path.dirname(e.dir)), 'f3d98a97f5bb', 'worktrees/<id>/<repo>')
  W.removeWorkspace(reg); r.cleanup()
})

check('addWorktree: idempotente (segunda llamada devuelve el mismo)', () => {
  const r = makeRepo('svc', ['main'], 'main')
  const reg = W.newRegistry(PAGE, r.root)
  const a = W.addWorktree(reg, r.clone, cfg), b = W.addWorktree(reg, r.clone, cfg)
  assert.equal(a.dir, b.dir); assert.equal(Object.keys(reg.repos).length, 1)
  W.removeWorkspace(reg); r.cleanup()
})

check('dos repos en un card: dos worktrees, dos entradas, PRs por repo', () => {
  const a = makeRepo('web', ['main'], 'main'), b = makeRepo('api', ['develop'], 'develop')
  const reg = W.newRegistry(PAGE, a.root)
  W.addWorktree(reg, a.clone, cfg); W.addWorktree(reg, b.clone, cfg)
  assert.deepEqual(Object.keys(reg.repos).sort(), ['api', 'web'])
  W.registerPr(reg, 'web', 'https://github.com/x/web/pull/1')
  assert.deepEqual(W.allPrs(reg), ['https://github.com/x/web/pull/1'])
  W.registerPr(reg, 'api', 'https://github.com/x/api/pull/2')
  assert.equal(W.allPrs(reg).length, 2)
  assert.equal(W.findRegistryByPr('https://github.com/x/api/pull/2')?.short_id, 'f3d98a97f5bb')
  assert.throws(() => W.registerPr(reg, 'nope', 'u'), /no tiene worktree/)
  const res = W.removeWorkspace(reg)
  assert.deepEqual(res.skipped, []); assert.equal(res.removed.length, 2)
  assert.ok(!fs.existsSync(W.registryPath('f3d98a97f5bb')))
  a.cleanup(); b.cleanup()
})

check('removeWorkspace: un worktree con cambios sin commitear se conserva', () => {
  const r = makeRepo('svc', ['main'], 'main')
  const reg = W.newRegistry(PAGE, r.root)
  const e = W.addWorktree(reg, r.clone, cfg)
  fs.writeFileSync(path.join(e.dir, 'wip'), 'x')
  const res = W.removeWorkspace(reg)
  assert.match(res.skipped[0], /sin commitear/)
  assert.ok(fs.existsSync(e.dir)); assert.ok(fs.existsSync(W.registryPath('f3d98a97f5bb')))
  fs.rmSync(path.join(e.dir, 'wip')); W.removeWorkspace(reg); r.cleanup()
})

check('dirtySharedCheckouts: detecta edición en el checkout compartido', () => {
  const r = makeRepo('root', ['main'], 'main')
  assert.deepEqual(W.dirtySharedCheckouts(r.clone), [])
  fs.writeFileSync(path.join(r.clone, 'f'), 'editado a mano')
  assert.deepEqual(W.dirtySharedCheckouts(r.clone), ['.'])
  r.cleanup()
})

check('ownerRepoOf: https y ssh', () => {
  assert.equal(W.ownerRepoOf('git@github.com:Org/repo.git'), 'Org/repo')
  assert.equal(W.ownerRepoOf('https://github.com/Org/repo'), 'Org/repo')
})

check('scanRepos: desciende en un monorepo con remoto y lista sus submódulos con ruta relativa', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'))
  const mk = (rel, origin) => {
    const d = path.join(root, rel); fs.mkdirSync(d, { recursive: true })
    execFileSync('git', ['init', '-q', d], { stdio: 'ignore' })
    if (origin) git(d, 'remote', 'add', 'origin', origin)
  }
  mk('talently-code', 'git@github.com:Org/talently-code.git')
  mk('talently-code/frontend/frontend-hire', 'git@github.com:Org/frontend-hire.git')
  mk('talently-code/backend/l9-backend', 'git@github.com:Org/l9-ops-backend-api.git')
  mk('solo', null)
  const repos = W.scanRepos(root)
  const rels = repos.map(r => r.rel).sort()
  assert.deepEqual(rels, ['solo', 'talently-code', 'talently-code/backend/l9-backend', 'talently-code/frontend/frontend-hire'])
  assert.equal(repos.find(r => r.rel === 'talently-code/backend/l9-backend').origin, 'git@github.com:Org/l9-ops-backend-api.git')
  assert.equal(W.findRepoByName('talently-code', root).rel, 'talently-code')
  fs.rmSync(root, { recursive: true, force: true })
})

if (failed) { console.error(`\n${failed} fallaron`); process.exit(1) }
