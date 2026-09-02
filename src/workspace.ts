/**
 * Workspace de un card: la raíz donde corre el agente (contexto completo) más
 * un worktree aislado por cada repo que decide cambiar. Un card puede tocar
 * varios repos — cada uno con su rama `agent/<id>` y su PR — y el registro en
 * log/workspaces/<id>.json es la única verdad sobre qué abrió.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { BRIDGE_DIR } from './env.ts'

const sh = (cmd: string, args: string[], cwd?: string) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd }) as string

export interface RepoEntry {
  repo: string
  dir: string
  branch: string
  base: string
  remote: string | null
  pr?: string
}

export interface Registry {
  page_id: string
  short_id: string
  root: string
  repos: Record<string, RepoEntry>
}

export interface BaseBranchConfig {
  default_base_branch?: string | null
  repo_base_branches?: Record<string, string>
}

export const WORKSPACES_DIR = path.join(BRIDGE_DIR, 'log', 'workspaces')
export const WORKTREES_DIR = path.join(BRIDGE_DIR, 'worktrees')

export const shortIdOf = (pageId: string): string => pageId.replace(/-/g, '').slice(-12)
export const registryPath = (shortId: string): string => path.join(WORKSPACES_DIR, `${shortId}.json`)
export const worktreesOf = (shortId: string): string => path.join(WORKTREES_DIR, shortId)

export function loadRegistry(shortId: string): Registry | null {
  const p = registryPath(shortId)
  if (!fs.existsSync(p)) return null
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Registry
}

export function saveRegistry(reg: Registry): void {
  fs.mkdirSync(WORKSPACES_DIR, { recursive: true })
  fs.writeFileSync(registryPath(reg.short_id), JSON.stringify(reg, null, 2) + '\n')
}

export function newRegistry(pageId: string, root: string): Registry {
  return { page_id: pageId, short_id: shortIdOf(pageId), root, repos: {} }
}

/** owner/repo de un origin de git (https o ssh) */
export function ownerRepoOf(origin: string): string | null {
  const m = origin.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/)
  return m ? `${m[1]}/${m[2]}` : null
}

/**
 * Rama base, en orden y sin heurística: override por repo → default_base_branch
 * si existe en el remoto → default del repo (origin/HEAD) → rama actual.
 */
export function resolveBaseBranch(repoPath: string, cfg: BaseBranchConfig): string {
  const exists = (ref: string): boolean => {
    try { sh('git', ['-C', repoPath, 'rev-parse', '--verify', '--quiet', `origin/${ref}`]); return true } catch { return false }
  }
  const override = cfg.repo_base_branches?.[path.basename(repoPath)]
  if (override) return override
  const preferred = cfg.default_base_branch
  if (preferred && exists(preferred)) return preferred
  try {
    const head = sh('git', ['-C', repoPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim().replace(/^origin\//, '')
    if (head) return head
  } catch { /* sin origin/HEAD */ }
  return sh('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD']).trim()
}

/** Los clones single-branch (submódulos) no traen `develop`: se ensancha el refspec antes de resolver la base. */
export function refreshRemote(repoPath: string): void {
  try { sh('git', ['-C', repoPath, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']) } catch { /* sin remoto */ }
  try { sh('git', ['-C', repoPath, 'fetch', 'origin', '--quiet']) } catch { /* offline ok */ }
}

function originOf(repoPath: string): string | null {
  try { return ownerRepoOf(sh('git', ['-C', repoPath, 'remote', 'get-url', 'origin']).trim()) } catch { return null }
}

/**
 * Abre (o reutiliza) el worktree aislado de un repo para este card:
 * worktrees/<id>/<repo> en la rama agent/<id> desde la base resuelta.
 */
export function addWorktree(reg: Registry, repoPath: string, cfg: BaseBranchConfig): RepoEntry {
  const name = path.basename(path.resolve(repoPath))
  const existing = reg.repos[name]
  if (existing && fs.existsSync(existing.dir)) return existing

  refreshRemote(repoPath)
  const base = resolveBaseBranch(repoPath, cfg)
  const branch = `agent/${reg.short_id}`
  const dir = path.join(worktreesOf(reg.short_id), name)
  fs.mkdirSync(worktreesOf(reg.short_id), { recursive: true })

  if (!fs.existsSync(dir)) {
    const hasBranch = (() => {
      try { sh('git', ['-C', repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]); return true } catch { return false }
    })()
    if (hasBranch) {
      sh('git', ['-C', repoPath, 'worktree', 'add', dir, branch])
    } else {
      let baseRef = `origin/${base}`
      try { sh('git', ['-C', repoPath, 'rev-parse', '--verify', '--quiet', baseRef]) } catch { baseRef = base }
      sh('git', ['-C', repoPath, 'worktree', 'add', '-b', branch, dir, baseRef])
    }
  }
  const entry: RepoEntry = { repo: path.resolve(repoPath), dir, branch, base, remote: originOf(repoPath) }
  reg.repos[name] = entry
  saveRegistry(reg)
  return entry
}

export function registerPr(reg: Registry, repoName: string, url: string): RepoEntry {
  const entry = reg.repos[repoName]
  if (!entry) throw new Error(`"${repoName}" no tiene worktree en este card — abrilo primero con regent-wt add`)
  entry.pr = url
  saveRegistry(reg)
  return entry
}

export const allPrs = (reg: Registry): string[] =>
  Object.values(reg.repos).map(r => r.pr).filter((p): p is string => Boolean(p))

export const allRemotes = (reg: Registry): string[] =>
  [...new Set(Object.values(reg.repos).map(r => r.remote).filter((r): r is string => Boolean(r)))]

/** Registros en disco: los cards con workspace abierto. */
export function listRegistries(): Registry[] {
  if (!fs.existsSync(WORKSPACES_DIR)) return []
  return fs.readdirSync(WORKSPACES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(WORKSPACES_DIR, f), 'utf8')) as Registry)
}

export function findRegistryByPr(prUrl: string): Registry | null {
  return listRegistries().find(r => allPrs(r).includes(prUrl)) ?? null
}

export interface RemoveResult { removed: string[]; skipped: string[] }

/**
 * Cierra el workspace del card: quita cada worktree y su rama. Conservador — un
 * worktree con cambios sin commitear se deja para que un humano decida.
 */
export function removeWorkspace(reg: Registry): RemoveResult {
  const out: RemoveResult = { removed: [], skipped: [] }
  for (const [name, r] of Object.entries(reg.repos)) {
    if (!fs.existsSync(r.dir)) { out.removed.push(name); continue }
    let dirty = false
    try { dirty = sh('git', ['-C', r.dir, 'status', '--porcelain']).trim() !== '' } catch { /* si status falla, remove sin --force protege igual */ }
    if (dirty) { out.skipped.push(`${name}: cambios sin commitear`); continue }
    try {
      sh('git', ['-C', r.repo, 'worktree', 'remove', r.dir])
      try { sh('git', ['-C', r.repo, 'branch', '-D', r.branch]) } catch { /* ya borrada */ }
      out.removed.push(name)
    } catch (err) {
      out.skipped.push(`${name}: ${(err as Error).message.split('\n')[0]}`)
    }
  }
  if (!out.skipped.length) {
    fs.rmSync(worktreesOf(reg.short_id), { recursive: true, force: true })
    fs.rmSync(registryPath(reg.short_id), { force: true })
  }
  return out
}

/** Submódulos/clones compartidos con cambios: el agente editó fuera de su worktree. */
export function dirtySharedCheckouts(root: string): string[] {
  const dirty: string[] = []
  try { if (sh('git', ['-C', root, 'status', '--porcelain', '--ignore-submodules=all']).trim()) dirty.push('.') } catch { /* no es repo */ }
  try {
    const out = sh('git', ['-C', root, 'submodule', 'foreach', '--quiet', 'git status --porcelain | grep -q . && echo "$sm_path" || true'])
    dirty.push(...out.split('\n').map(s => s.trim()).filter(Boolean))
  } catch { /* sin submódulos */ }
  return dirty
}
