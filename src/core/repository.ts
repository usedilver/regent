import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

/** True when `target` is `root` itself or lives below it. Both paths must already be absolute. */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export function requireSameProject(current: string, target: string): void {
  if (current !== target) {
    throw new Error(
      'Esta conversación está vinculada a otro proyecto. Abre una nueva conversación (un hilo nuevo en Slack) y selecciona allí el proyecto antes de continuar. Los servicios y submódulos del mismo proyecto sí pueden compartir esta sesión.',
    )
  }
}

/**
 * Where the CLI keeps a project's memory. Its worktrees share it, so the agent remembers
 * across conversations and requesters.
 */
export function memoryDirectory(project: string): string {
  const slug = fs.realpathSync(project).replace(/[^a-zA-Z0-9]/g, '-')
  const home = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')
  return path.join(home, 'projects', slug, 'memory')
}

/** Where a project keeps its conversations' worktrees, relative to its root. */
export const WORKTREES_DIRECTORY = '.worktrees'
/** Where the CLI created them before Regent chose the location; existing ones stay there. */
const NATIVE_WORKTREES_DIRECTORY = path.join('.claude', 'worktrees')

/**
 * The worktree a conversation owns in a project: always below the project root, whichever
 * repository of the project the work happens in.
 */
export function isolationFor(repo: string, conversation: string) {
  const root = fs.realpathSync(repo)
  const name = `regent-${createHash('sha256')
    .update(JSON.stringify([root, conversation]))
    .digest('hex')
    .slice(0, 24)}`
  const native = path.join(root, NATIVE_WORKTREES_DIRECTORY, name)
  const dir = fs.existsSync(path.join(native, '.git'))
    ? native
    : path.join(root, WORKTREES_DIRECTORY, name)

  return { name, dir }
}

export function resolveRepository(workspace: string, value: string): string {
  const root = fs.realpathSync(workspace)
  const dir = fs.realpathSync(path.resolve(root, value))

  if (!isInside(root, dir)) {
    throw new Error('El proyecto debe estar dentro del workspace autorizado.')
  }

  if (!fs.statSync(dir).isDirectory() || !fs.existsSync(path.join(dir, '.git'))) {
    throw new Error('Indica la raiz de un repositorio existente.')
  }

  return dir
}

export function projectRoot(workspace: string, repo: string): string {
  let current = resolveRepository(workspace, repo)

  while (true) {
    let parent: string

    try {
      parent = execFileSync('git', ['rev-parse', '--show-superproject-working-tree'], {
        cwd: current,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
      }).trim()
    } catch {
      return current
    }

    if (!parent) return current
    const resolved = resolveRepository(workspace, parent)

    if (resolved === current || !isInside(resolved, current)) {
      throw new Error('Relacion de submodulo invalida.')
    }

    current = resolved
  }
}

/** Optional explicit selector, never a heuristic over URLs or ordinary prose. */
export function repositoryRequest(text: string): { text: string; repo?: string } {
  if (!/^repo:/i.test(text)) return { text }
  const match = text.match(/^repo:[ \t]*([^\r\n]+)\r?\n([\s\S]+)$/i)
  if (!match) throw new Error('Indica repo: <ruta> y la solicitud en la siguiente linea.')
  const repo = match[1].trim().replace(/^(["'])(.*)\1$/, '$2')

  if (!repo || !match[2].trim()) {
    throw new Error('Indica repo: <ruta> y la solicitud en la siguiente linea.')
  }

  return { repo, text: match[2].trim() }
}
