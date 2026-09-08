import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export function isolationFor(repo: string, conversation: string) {
  const root = fs.realpathSync(repo)
  const name = `regent-${createHash('sha256').update(JSON.stringify([root, conversation])).digest('hex').slice(0, 24)}`
  return { name, dir: path.join(root, '.claude', 'worktrees', name) }
}

export function resolveRepository(workspace: string, value: string): string {
  const root = fs.realpathSync(workspace)
  const dir = fs.realpathSync(path.resolve(root, value))
  const relative = path.relative(root, dir)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('El proyecto debe estar dentro del workspace autorizado.')
  }
  if (!fs.statSync(dir).isDirectory() || !fs.existsSync(path.join(dir, '.git'))) {
    throw new Error('Indica la raiz de un repositorio existente.')
  }
  return dir
}
