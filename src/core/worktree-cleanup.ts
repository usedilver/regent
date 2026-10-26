import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { inspectProcess } from '../previews/process.ts'
import { isInside, isolationFor } from './repository.ts'

const execute = promisify(execFile)
export async function workspaceGit(cwd: string, args: string[], signal?: AbortSignal) {
  const result = await execute(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    {
      cwd,
      signal,
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
      },
    },
  )
  return result.stdout.trimEnd()
}

interface Checkout {
  directory: string
  source: string
  baseline?: string
  branch?: string
  lock?: string
}
export interface CleanupPullRequest {
  directory: string
  number: number
}
export interface CleanupResult {
  state: 'removed' | 'absent' | 'blocked'
  message: string
  removed?: string[]
}

export function cleanupText(cleanup: CleanupResult, report: string): string {
  return [
    cleanup.message,
    report.trim() ? `Informe del agente sobre las acciones solicitadas:\n${report.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

function inventory(text: string): Array<{ directory: string; branch?: string; lock?: string }> {
  const rows: Array<{ directory: string; branch?: string; lock?: string }> = []
  for (const field of text.split('\0')) {
    if (field.startsWith('worktree ')) rows.push({ directory: field.slice(9) })
    else if (field.startsWith('branch ')) rows.at(-1)!.branch = field.slice(7)
    else if (field === 'locked' || field.startsWith('locked ')) rows.at(-1)!.lock = field.slice(7)
  }
  return rows
}

/** Discover registered checkouts, including nested submodules and preview worktrees. */
export async function cleanupPlan(
  project: string,
  key: string,
  signal?: AbortSignal,
): Promise<Checkout[]> {
  const root = isolationFor(project, key).dir
  if (!fs.existsSync(root)) return []
  if (fs.realpathSync(root) !== root)
    throw new Error('El worktree es un enlace simbolico; no se eliminara.')
  const found = new Map<string, Checkout>()
  const baselines = new Map<string, string>()
  const seen = new Set<string>()
  const visit = async (source: string) => {
    const common = fs.realpathSync(
      path.resolve(source, await workspaceGit(source, ['rev-parse', '--git-common-dir'], signal)),
    )
    if (seen.has(common)) return
    seen.add(common)
    const rows = inventory(
      await workspaceGit(source, ['worktree', 'list', '--porcelain', '-z'], signal),
    )
    for (const row of rows) {
      if (!isInside(root, row.directory)) continue
      if (
        row.directory === fs.realpathSync(project) ||
        !fs.existsSync(row.directory) ||
        fs.realpathSync(row.directory) !== row.directory
      ) {
        throw new Error('Hay un checkout enlazado o inconsistente; no se eliminara.')
      }
      found.set(row.directory, { ...row, source, baseline: baselines.get(row.directory) })
      const entries = (
        await workspaceGit(row.directory, ['ls-files', '--stage', '-z'], signal)
      ).split('\0')
      for (const entry of entries) {
        if (!entry.startsWith('160000 ')) continue
        const relative = entry.slice(entry.indexOf('\t') + 1)
        const original = path.resolve(source, relative)
        const child = path.resolve(row.directory, relative)
        if (!isInside(project, original) || !isInside(root, child))
          throw new Error('Submodulo fuera del proyecto.')
        if (!fs.existsSync(path.join(child, '.git'))) continue
        if (!fs.existsSync(path.join(original, '.git')))
          throw new Error('No se encontro el origen de un submodulo.')
        if (fs.realpathSync(child) !== child || fs.realpathSync(original) !== original)
          throw new Error('Submodulo enlazado fuera del checkout.')
        const childCommon = fs.realpathSync(
          path.resolve(child, await workspaceGit(child, ['rev-parse', '--git-common-dir'], signal)),
        )
        const originalCommon = fs.realpathSync(
          path.resolve(
            original,
            await workspaceGit(original, ['rev-parse', '--git-common-dir'], signal),
          ),
        )
        if (childCommon !== originalCommon)
          throw new Error('El submodulo no corresponde a su repositorio de origen.')
        baselines.set(child, entry.split(' ')[1])
        await visit(original)
      }
    }
  }
  await visit(project)
  if (!found.has(root)) throw new Error('El directorio no es un worktree registrado del proyecto.')
  return [...found.values()].sort((a, b) => b.directory.length - a.directory.length)
}

async function assertSaved(
  checkout: Checkout,
  pullRequests: CleanupPullRequest[],
  root: string,
  signal?: AbortSignal,
) {
  const status = await workspaceGit(
    checkout.directory,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'],
    signal,
  )
  if (status)
    throw new Error(`Hay cambios sin commit en ${checkout.directory}. Se conserva el worktree.`)
  const head = await workspaceGit(checkout.directory, ['rev-parse', 'HEAD'], signal)
  // The clean pinned baseline is already retained by the parent project and its
  // local submodule branch, which cleanup never deletes. Only new work needs a
  // fresh remote backup; unrelated source checkouts may contain older history.
  if (head === checkout.baseline) {
    const retained = await workspaceGit(
      checkout.source,
      ['for-each-ref', '--format=%(refname)', '--contains', head, 'refs/heads'],
      signal,
    )
    if (!retained)
      throw new Error('El commit inicial del submodulo no tiene una rama local que lo conserve.')
  } else {
    await workspaceGit(
      checkout.source,
      ['fetch', '--prune', '--no-recurse-submodules', 'origin'],
      signal,
    )
    for (const pr of pullRequests) {
      if (path.resolve(root, pr.directory) !== checkout.directory) continue
      if (!Number.isSafeInteger(pr.number) || pr.number < 1)
        throw new Error('Numero de PR invalido.')
      // Fetch the remote PR ref only for an explicitly identified repository/PR.
      // This preserves squash-merged commits even when the source branch was deleted.
      await workspaceGit(
        checkout.source,
        [
          'fetch',
          '--no-recurse-submodules',
          'origin',
          `refs/pull/${pr.number}/head:refs/regent/cleanup/pr-${pr.number}`,
        ],
        signal,
      )
    }
    const remote = await workspaceGit(
      checkout.source,
      [
        'for-each-ref',
        '--format=%(refname)',
        '--contains',
        head,
        'refs/remotes/origin',
        ...pullRequests
          .filter((pr) => path.resolve(root, pr.directory) === checkout.directory)
          .map((pr) => `refs/regent/cleanup/pr-${pr.number}`),
      ],
      signal,
    )
    if (!remote)
      throw new Error(
        `Hay commits sin respaldo verificable en remoto en ${checkout.directory}. Se conserva el worktree.`,
      )
  }
  if (checkout.lock !== undefined) {
    // This is native CLI lock metadata, never a classifier over user requests.
    const lock = /^claude session regent-[a-f0-9]+ \(pid (\d+) start (\d+)\)$/.exec(checkout.lock)
    if (!lock) throw new Error('El worktree tiene un bloqueo manual o desconocido; no se quitara.')
    const process = inspectProcess(Number(lock[1]))
    if (process?.start === lock[2]) throw new Error('El CLI todavia esta usando el worktree.')
  }
}

async function processesInside(root: string): Promise<boolean> {
  if (process.platform === 'linux') {
    return fs.readdirSync('/proc').some((entry) => {
      if (!/^\d+$/.test(entry)) return false
      const info = inspectProcess(Number(entry))
      return info !== null && isInside(root, info.cwd)
    })
  }
  const result = await execute('lsof', ['-nP', '-d', 'cwd', '-Fn'], {
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
  })
  return result.stdout
    .split('\n')
    .some((line) => line.startsWith('n') && isInside(root, line.slice(1)))
}

export async function removeConversationWorktree(
  project: string,
  key: string,
  stopPreview: () => void,
  pullRequests: CleanupPullRequest[] = [],
  signal?: AbortSignal,
): Promise<CleanupResult> {
  const root = isolationFor(project, key).dir
  const plan = await cleanupPlan(project, key, signal)
  if (!plan.length) {
    stopPreview()
    return {
      state: 'absent',
      message: 'El worktree ya no existe; no hay nada pendiente de borrar.',
    }
  }
  // Complete preflight before stopping a review or removing any checkout.
  for (const checkout of plan) await assertSaved(checkout, pullRequests, root, signal)
  stopPreview()
  const deadline = Date.now() + 6500
  while (await processesInside(root)) {
    signal?.throwIfAborted()
    if (Date.now() >= deadline)
      throw new Error('Hay procesos usando el worktree; se conserva hasta que terminen.')
    await delay(200, undefined, { signal })
  }
  const removed: string[] = []
  for (const checkout of plan) {
    signal?.throwIfAborted()
    // Recheck after process shutdown; generated ignored files are disposable.
    const dirty = await workspaceGit(
      checkout.directory,
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'],
      signal,
    )
    if (dirty) throw new Error('El contenido cambio durante la limpieza; se conserva lo que queda.')
    if (checkout.lock !== undefined)
      await workspaceGit(checkout.source, ['worktree', 'unlock', checkout.directory], signal)
    // Git requires force for a superproject containing registered submodule checkouts.
    // All tracked/untracked work and remote reachability were checked above.
    await workspaceGit(
      checkout.source,
      ['worktree', 'remove', '--force', checkout.directory],
      signal,
    )
    removed.push(checkout.directory)
  }
  return {
    state: 'removed',
    removed,
    message:
      'Worktree y checkouts anidados eliminados; preview detenido. Los commits remotos y el historial de la conversacion se conservan.',
  }
}
