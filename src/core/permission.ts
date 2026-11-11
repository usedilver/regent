import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { denial } from '../../plugins/executor/hooks/policy.mjs'
import type { Active, Core } from './core.ts'
import { isInside, isolationFor } from './repository.ts'

export interface PermissionInput {
  tool_name: string
  tool_input?: Record<string, any>
  cwd?: string
}

/** Tools that touch project files and therefore need the isolated workspace ready first. */
export const PROJECT_FILE_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'PowerShell',
  'Monitor',
])

/** Whether the project, in its shared checkout or its worktree, declares submodules to prepare. */
export function hasSubmodules(cwd: string, isolationDir: string): boolean {
  return (
    fs.existsSync(path.join(cwd, '.gitmodules')) ||
    fs.existsSync(path.join(isolationDir, '.gitmodules'))
  )
}

/** The conversation's worktree once this run works in it, whether it started or moved there. */
function enteredWorktree(active: Active, isolationDir: string): string | undefined {
  if (active.executionDir !== isolationDir) return
  // A worktree removed or replaced by a link mid-run is no longer an editable place.
  return realDirectory(isolationDir) === isolationDir && fs.existsSync(isolationDir)
    ? isolationDir
    : undefined
}

/** Where a tool call runs, resolved through symlinks; an unreadable place counts as shared. */
function realDirectory(directory: string): string {
  try {
    return fs.realpathSync(directory)
  } catch {
    return directory
  }
}

/** The native tool may only create or enter the worktree Regent tracks for this conversation. */
function enterWorktreeDenial(
  input: PermissionInput,
  project: string,
  isolation: { name: string; dir: string },
  entered: boolean,
): string | null {
  if (!fs.existsSync(path.join(project, '.git'))) {
    return 'This project is not a Git repository, so it has no worktree to enter.'
  }

  if (entered) return 'This conversation already works in its worktree.'
  const { name, path: requested } = input.tool_input ?? {}

  return name === isolation.name && requested === undefined
    ? null
    : `Enter this conversation's own worktree: call EnterWorktree with name "${isolation.name}" and no path.`
}

/**
 * The reason a tool call must be denied, or null to let it run. Every run investigates with all
 * its tools from wherever it started. Edits land in the conversation's worktree or in scratch
 * locations, and the checkout every conversation shares keeps its Git state and dependencies;
 * everything else defers to the executor policy hook.
 */
export function permissionDenial(
  core: Core,
  active: Active,
  input: PermissionInput,
): string | null {
  const cwd = core.store.conversation(active.run.conversation_key)?.cwd ?? core.defaultCwd
  const isolation = isolationFor(cwd, active.run.conversation_key)
  const worktree = enteredWorktree(active, isolation.dir)
  const needsWorkspace = worktree && PROJECT_FILE_TOOLS.has(input.tool_name) && !active.workspace

  if (needsWorkspace && hasSubmodules(cwd, isolation.dir)) {
    return 'Espera a que termine la preparacion del proyecto aislado antes de usar herramientas.'
  }

  const submodule = submoduleDenial(active, input, cwd, isolation.dir)
  if (submodule) return submodule

  if (input.tool_name === 'EnterWorktree') {
    return enterWorktreeDenial(input, cwd, isolation, Boolean(worktree))
  }

  if (input.tool_name === 'ExitWorktree') {
    return 'Conserva el aislamiento de esta conversacion; usa regent_use_repo para cambiar de proyecto.'
  }

  const directory = realDirectory(input.cwd ?? worktree ?? cwd)
  // The project's checkout, and the worktrees of other conversations below it, are shared; a
  // new project being created elsewhere in the workspace is not.
  const shared =
    isInside(realDirectory(cwd), directory) && !(worktree && isInside(worktree, directory))

  return denial(input, {
    ...process.env,
    REGENT_PERMISSION_MODE: core.config.permission_mode === 'native' ? 'repository' : '',
    REGENT_ROOT: worktree ?? '',
    REGENT_CWD: directory,
    REGENT_WORKSPACE: core.cwd,
    REGENT_WORKTREE_NAME: fs.existsSync(path.join(cwd, '.git')) ? isolation.name : '',
    REGENT_SCRATCH: JSON.stringify([
      os.tmpdir(),
      '/tmp',
      core.attachments.directory(active.run.conversation_key),
    ]),
    REGENT_SHARED: shared ? '1' : '',
    REGENT_READONLY_MCP: JSON.stringify(core.config.repos.readonly_mcp),
  })
}

/**
 * A tool aimed at a submodule without a checkout in the worktree would see an empty directory.
 * Unavailable ones cannot be prepared; pending ones are checked out on request.
 */
function submoduleDenial(
  active: Active,
  input: PermissionInput,
  project: string,
  isolationDir: string,
): string | null {
  if (!active.workspace) return null
  const base = input.cwd ?? isolationDir
  const destinations = [
    input.cwd,
    input.tool_input?.file_path,
    input.tool_input?.notebook_path,
    input.tool_input?.path,
  ].filter((value): value is string => typeof value === 'string')
  const touched = (relative: string) =>
    destinations.some((destination) =>
      isInside(path.join(isolationDir, relative), path.resolve(base, destination)),
    )

  if (active.workspace.unavailable.some(touched)) {
    return 'El submodulo no esta inicializado en el proyecto de origen. Prepara su checkout antes de usarlo; no edites un directorio vacio como si fuera el servicio.'
  }

  const pending = active.workspace.pending.find(touched)
  if (!pending) return null
  const source = path.join(project, pending)

  return `The submodule ${JSON.stringify(pending)} has no checkout in this conversation's worktree yet. Call regent_use_repo with ${JSON.stringify(pending)} before changing or running it; to only read it, use the shared checkout at ${source}.`
}
