import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BRIDGE_DIR } from '../env.ts'
import { ownerRepoOf, resolveBaseBranch } from '../workspace.ts'
import type { Config } from './config.ts'
import { Store, redact } from './store.ts'

const exec = promisify(execFile)
export const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export interface Worktree {
  id: string; conversation_key: string; repo: string; dir: string; branch: string; base: string; base_sha: string
  origin: string; test_command: string | null; test_tree: string | null; test_passed: number; state: string
}
export interface DiffFile { path: string; added: number; removed: number; binary: boolean }
export type Command = (command: string, args: string[], cwd: string, signal?: AbortSignal) => Promise<string>
export const command: Command = async (cmd, args, cwd, signal) => {
  signal?.throwIfAborted()
  const pending = exec(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    detached: process.platform !== 'win32', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GH_PAGER: 'cat', CI: 'true' } } as any)
  const child = pending.child
  let stopped = false, killTimer: NodeJS.Timeout | undefined
  const kill = (sig: NodeJS.Signals) => {
    try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig); else child.kill(sig) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
  const stop = () => {
    if (stopped) return
    stopped = true; kill('SIGTERM')
    killTimer = setTimeout(() => kill('SIGKILL'), 1000)
  }
  const timeout = setTimeout(stop, 600000)
  signal?.addEventListener('abort', stop, { once: true })
  try {
    const result = await pending
    if (stopped) throw new Error('Comando cancelado o fuera de tiempo.')
    return String(result.stdout)
  } finally {
    clearTimeout(timeout); clearTimeout(killTimer); signal?.removeEventListener('abort', stop)
    if (stopped) kill('SIGKILL')
  }
}

export function parseNumstat(raw: string): DiffFile[] {
  return raw.split('\0').filter(Boolean).map(line => {
    const match = line.match(/^([^\t]+)\t([^\t]+)\t([\s\S]+)$/)
    if (!match) throw new Error('Diff numstat invalido.')
    const [, added, removed, file] = match
    if (!/^(?:\d+|-)$/.test(added) || !/^(?:\d+|-)$/.test(removed)) throw new Error('Diff numstat invalido.')
    return { path: file, added: added === '-' ? 0 : Number(added), removed: removed === '-' ? 0 : Number(removed), binary: added === '-' || removed === '-' }
  })
}

export function smallFix(files: DiffFile[], config: Config['policy']['small_fix']): string | null {
  if (!files.length) return 'No hay cambios para publicar.'
  if (files.length > config.max_files) return `El cambio toca ${files.length} archivos (maximo ${config.max_files}).`
  if (files.some(file => file.binary)) return 'Los cambios binarios requieren una tarea.'
  const denied = files.find(file => config.deny_paths.some(pattern => path.posix.matchesGlob(file.path, pattern)))
  if (denied) return `La ruta ${denied.path} requiere una tarea.`
  const lines = files.reduce((sum, file) => sum + file.added + file.removed, 0)
  if (lines > config.max_lines) return `El cambio tiene ${lines} lineas (maximo ${config.max_lines}).`
  return null
}

export class Changes {
  store: Store; config: Config; root: string; directory: string; cmd: Command
  locks = new Map<string, Promise<any>>()
  constructor(store: Store, config: Config, root: string, directory = path.join(BRIDGE_DIR, 'worktrees/v2'), cmd = command) {
    this.store = store; this.config = config; this.root = fs.realpathSync(root); this.directory = path.resolve(directory); this.cmd = cmd
  }
  exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(operation).finally(() => { if (this.locks.get(id) === current) this.locks.delete(id) })
    this.locks.set(id, current)
    return current
  }
  list(key: string): Worktree[] { return this.store.db.prepare("SELECT * FROM worktrees WHERE conversation_key=? AND state='active'").all(key) as unknown as Worktree[] }
  testCommand(repo: string): string[] | undefined {
    return this.config.repos.test_commands[path.relative(this.root, repo) || '.'] ?? this.config.repos.test_commands[path.basename(repo)]
  }
  get(key: string, repo: string): Worktree {
    const resolved = this.repo(repo)
    const row = this.list(key).find(w => w.repo === resolved)
    if (!row) throw new Error('Primero abre un worktree de ese repo con regent_worktree.')
    return row
  }
  repo(repo: string): string {
    const target = fs.realpathSync(path.resolve(this.root, repo))
    const relative = path.relative(this.root, target)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('El repo debe estar dentro del workspace configurado.')
    if (!fs.existsSync(path.join(target, '.git'))) throw new Error('Indica la raiz exacta del repo o submodulo.')
    return target
  }
  async open(key: string, repo: string, signal?: AbortSignal): Promise<Worktree> {
    const target = this.repo(repo), id = hash(`${key}\n${target}`).slice(0, 24)
    return this.exclusive(id, async () => {
      const previous = this.store.db.prepare('SELECT * FROM worktrees WHERE id=?').get(id) as unknown as Worktree | undefined
      if (previous) {
        if (previous.state !== 'active') throw new Error('El worktree de esta conversacion ya fue cerrado; inicia una conversacion nueva.')
        await this.assertBranch(previous, signal)
        await this.cmd('git', ['fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*', '--quiet'], previous.repo, signal)
        const newBase = (await this.cmd('git', ['rev-parse', `refs/remotes/origin/${previous.base}`], previous.repo, signal)).trim()
        if (newBase !== previous.base_sha) {
          if ((await this.cmd('git', ['status', '--porcelain'], previous.dir, signal)).trim()) throw new Error('La base remota avanzo y hay cambios locales. Conservados: termina el diff antes de sincronizar.')
          try { await this.cmd('git', ['merge', '--no-edit', newBase], previous.dir, signal) }
          catch (error) {
            try { await this.cmd('git', ['merge', '--abort'], previous.dir) } catch { /* no merge in progress */ }
            throw new Error(`Conflicto al sincronizar la base; worktree conservado: ${(error as Error).message}`)
          }
          this.store.db.prepare('UPDATE worktrees SET base_sha=?,test_tree=NULL,test_passed=0 WHERE id=?').run(newBase, previous.id)
          return this.get(key, repo)
        }
        return previous
      }
      await this.cmd('git', ['fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*', '--quiet'], target, signal)
      const base = resolveBaseBranch(target, { default_base_branch: this.config.repos.default_base_branch, repo_base_branches: this.config.repos.base_branches })
      const baseSha = (await this.cmd('git', ['rev-parse', `refs/remotes/origin/${base}`], target, signal)).trim()
      const origin = (await this.cmd('git', ['remote', 'get-url', 'origin'], target, signal)).trim()
      fs.mkdirSync(this.directory, { recursive: true })
      this.directory = fs.realpathSync(this.directory)
      const dir = path.join(this.directory, id), branch = `agent/${hash(key).slice(0, 12)}-${hash(target).slice(0, 8)}`
      let exists = false
      try { await this.cmd('git', ['show-ref', '--verify', `refs/heads/${branch}`], target, signal); exists = true } catch { /* new branch */ }
      if (!fs.existsSync(dir)) await this.cmd('git', ['worktree', 'add', ...(exists ? [] : ['-b', branch]), dir, exists ? branch : baseSha], target, signal)
      let testCommand = this.testCommand(target)
      if (!testCommand) {
        let pkg: any
        try { pkg = JSON.parse(await this.cmd('git', ['show', `${baseSha}:package.json`], target, signal)) } catch { /* repo without package.json */ }
        if (typeof pkg?.scripts?.test === 'string') testCommand = [pkg.packageManager?.startsWith('pnpm@') ? 'pnpm' : pkg.packageManager?.startsWith('yarn@') ? 'yarn' : 'npm', 'run', 'test']
      }
      const row: Worktree = { id, conversation_key: key, repo: target, dir, branch, base, base_sha: baseSha, origin,
        test_command: testCommand ? JSON.stringify(testCommand) : null, test_tree: null, test_passed: 0, state: 'active' }
      await this.assertBranch(row, signal)
      this.store.db.prepare('INSERT INTO worktrees(id,conversation_key,repo,dir,branch,base,base_sha,origin,test_command) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, key, target, dir, branch, base, baseSha, origin, row.test_command)
      return row
    })
  }
  async assertBranch(w: Worktree, signal?: AbortSignal): Promise<void> {
    const branch = (await this.cmd('git', ['branch', '--show-current'], w.dir, signal)).trim()
    if (branch !== w.branch || !w.branch.startsWith('agent/')) throw new Error('El worktree cambio de rama; no se publicara.')
  }
  async snapshot(w: Worktree, signal?: AbortSignal) {
    await this.assertBranch(w, signal)
    await this.cmd('git', ['add', '--all', '--', '.'], w.dir, signal)
    const tree = (await this.cmd('git', ['write-tree'], w.dir, signal)).trim()
    const files = parseNumstat(await this.cmd('git', ['diff', '--cached', '--numstat', '-z', '--no-renames', w.base_sha, '--'], w.dir, signal))
    if (files.some(f => /(?:^|\/)\.env(?:$|\.)|\.credentials\.json/.test(f.path) && !f.path.endsWith('.example'))) throw new Error('El diff contiene archivos de secretos; retiralos antes de publicar.')
    return { tree, files }
  }
  async tests(key: string, repo: string, signal?: AbortSignal) {
    const w = this.get(key, repo)
    return this.exclusive(w.id, async () => {
      this.store.db.prepare('UPDATE worktrees SET test_passed=0,test_tree=NULL WHERE id=?').run(w.id)
      const before = await this.snapshot(w, signal)
      if (!w.test_command) return { skipped: true, reason: 'El repo no declara comando de test; configura repos.test_commands para otros lenguajes.' }
      // Do not let a patch replace the test entry point with a command that always passes.
      const changedManifest = before.files.some(f => f.path === 'package.json')
      const independent = this.testCommand(w.repo)
      if (changedManifest && !independent) {
        const original = JSON.parse(await this.cmd('git', ['show', `${w.base_sha}:package.json`], w.dir, signal))
        const current = JSON.parse(fs.readFileSync(path.join(w.dir, 'package.json'), 'utf8'))
        if (JSON.stringify(original.scripts) !== JSON.stringify(current.scripts)) throw new Error('Los scripts de test cambiaron: configura un comando de verificacion independiente en repos.test_commands.')
      }
      const [cmd, ...args] = JSON.parse(w.test_command)
      const output = await this.cmd(cmd, args, w.dir, signal)
      const after = await this.snapshot(w, signal)
      if (after.tree !== before.tree) throw new Error('El arbol cambio durante los tests; vuelve a ejecutarlos sobre el diff final.')
      this.store.db.prepare('UPDATE worktrees SET test_passed=1,test_tree=? WHERE id=?').run(after.tree, w.id)
      return { passed: true, tree: after.tree, output: redact(output).slice(-8000) }
    })
  }
  async install(key: string, repo: string, signal?: AbortSignal) {
    const w = this.get(key, repo)
    return this.exclusive(w.id, async () => {
      let pkg: any
      try { pkg = JSON.parse(await this.cmd('git', ['show', `${w.base_sha}:package.json`], w.dir, signal)) }
      catch { throw new Error('La instalacion automatica admite repositorios Node con package.json.') }
      const manager = pkg.packageManager?.startsWith('pnpm@') ? 'pnpm' : pkg.packageManager?.startsWith('yarn@') ? 'yarn' : 'npm'
      const args = manager === 'pnpm' ? ['install', '--frozen-lockfile'] : manager === 'yarn' ? ['install', '--immutable'] : ['ci']
      this.store.db.prepare('UPDATE worktrees SET test_passed=0,test_tree=NULL WHERE id=?').run(w.id)
      return { installed: true, output: redact(await this.cmd(manager, args, w.dir, signal)).slice(-8000) }
    })
  }
  async publish(key: string, args: { repo: string; title: string; body_md: string }, taskApproved: boolean, signal?: AbortSignal) {
    const w = this.get(key, args.repo)
    return this.exclusive(w.id, async () => {
      const { tree, files } = await this.snapshot(w, signal)
      if (!taskApproved) {
        const reason = smallFix(files, this.config.policy.small_fix)
        if (reason) return { refused: true, reason, suggestion: 'regent_create_task' }
      }
      if (!files.length) throw new Error('No hay cambios respecto de la base.')
      const current = this.get(key, args.repo)
      if (w.test_command && this.config.policy.small_fix.require_tests_pass && (!current.test_passed || current.test_tree !== tree)) {
        return { refused: true, reason: 'Faltan tests aprobados sobre este diff exacto.', suggestion: 'regent_run_tests' }
      }
      const ownerRepo = ownerRepoOf(w.origin)
      if (!ownerRepo) throw new Error('El remoto origin no es un repositorio GitHub reconocido.')
      const existing = JSON.parse(await this.cmd('gh', ['pr', 'list', '--repo', ownerRepo, '--head', w.branch, '--state', 'all', '--json', 'url,state'], w.dir, signal))
      if (existing.some((p: any) => p.state !== 'OPEN')) throw new Error('Esta rama ya tiene un PR cerrado; usa una conversacion nueva.')
      const headTree = (await this.cmd('git', ['rev-parse', 'HEAD^{tree}'], w.dir, signal)).trim()
      if (tree !== headTree) await this.cmd('git', ['commit', '-m', args.title], w.dir, signal)
      if ((await this.snapshot(w, signal)).tree !== tree) throw new Error('El commit modifico el diff verificado; vuelve a ejecutar tests.')
      const head = (await this.cmd('git', ['rev-parse', 'HEAD'], w.dir, signal)).trim()
      await this.cmd('git', ['push', 'origin', `HEAD:refs/heads/${w.branch}`], w.dir, signal)
      const temp = fs.mkdtempSync(path.join(this.directory, '.pr-'))
      let url: string
      try {
        const bodyFile = path.join(temp, 'body.md')
        fs.writeFileSync(bodyFile, args.body_md, { mode: 0o600 })
        if (existing[0]) {
          url = existing[0].url
          await this.cmd('gh', ['pr', 'edit', url, '--repo', ownerRepo, '--title', args.title, '--body-file', bodyFile], w.dir, signal)
        } else url = (await this.cmd('gh', ['pr', 'create', '--repo', ownerRepo, '--head', w.branch, '--base', w.base, '--title', args.title, '--body-file', bodyFile], w.dir, signal)).trim()
      } finally { fs.rmSync(temp, { recursive: true, force: true }) }
      if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url)) throw new Error('GitHub no devolvio una URL de PR valida.')
      this.store.db.prepare("INSERT INTO prs(worktree_id,url,head) VALUES(?,?,?) ON CONFLICT(worktree_id) DO UPDATE SET url=excluded.url,head=excluded.head,state='OPEN'").run(w.id, url, head)
      return { url, head, branch: w.branch }
    })
  }
  async merged(w: Worktree, url: string): Promise<boolean> {
    const pr = JSON.parse(await this.cmd('gh', ['pr', 'view', url, '--repo', ownerRepoOf(w.origin)!, '--json', 'state,headRefOid,baseRefName,headRefName'], w.dir))
    const stored = this.store.db.prepare('SELECT head FROM prs WHERE worktree_id=?').get(w.id)
    return pr.state === 'MERGED' && pr.headRefOid === stored?.head && pr.baseRefName === w.base && pr.headRefName === w.branch
  }
  async clean(w: Worktree): Promise<boolean> {
    return this.exclusive(w.id, async () => {
      if (!fs.existsSync(w.dir)) { this.store.db.prepare("UPDATE worktrees SET state='cleaned' WHERE id=?").run(w.id); return true }
      if ((await this.cmd('git', ['status', '--porcelain'], w.dir)).trim()) return false
      await this.cmd('git', ['worktree', 'remove', w.dir], w.repo)
      this.store.db.prepare("UPDATE worktrees SET state='cleaned' WHERE id=?").run(w.id)
      return true
    })
  }
}
