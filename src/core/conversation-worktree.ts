import fs from 'node:fs'
import path from 'node:path'
import { copySetupFiles } from './project-workspace.ts'
import { isolationFor, WORKTREES_DIRECTORY } from './repository.ts'
import { workspaceGit } from './worktree-cleanup.ts'

const EXCLUDE_ENTRY = `/${WORKTREES_DIRECTORY}/`

export interface ConversationWorktree {
  name: string
  dir: string
  created: boolean
}

/** Keeps the worktrees out of the shared checkout's status without touching its tracked files. */
async function excludeFromStatus(project: string, signal?: AbortSignal): Promise<void> {
  const common = path.resolve(
    project,
    await workspaceGit(project, ['rev-parse', '--git-common-dir'], signal),
  )
  const file = path.join(common, 'info', 'exclude')
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''

  if (current.split('\n').includes(EXCLUDE_ENTRY)) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}${EXCLUDE_ENTRY}\n`)
}

/**
 * The conversation's worktree, created from the project root when it does not exist yet. The
 * location never depends on where the CLI session stands, so a session that moved into a
 * submodule still gets its worktree at the project root.
 */
export async function ensureConversationWorktree(
  project: string,
  key: string,
  signal?: AbortSignal,
): Promise<ConversationWorktree> {
  const { name, dir } = isolationFor(project, key)

  if (fs.existsSync(path.join(dir, '.git'))) return { name, dir, created: false }

  if (fs.existsSync(dir)) {
    throw new Error('The conversation worktree directory exists and is not a Git worktree.')
  }

  await excludeFromStatus(project, signal)
  const branch = `worktree-${name}`
  const existing = await workspaceGit(
    project,
    ['for-each-ref', '--format=%(refname)', `refs/heads/${branch}`],
    signal,
  )
  await workspaceGit(
    project,
    existing ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, 'HEAD'],
    signal,
  )
  await copySetupFiles(project, dir, signal)

  return { name, dir, created: true }
}
