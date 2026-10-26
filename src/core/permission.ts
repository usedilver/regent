import fs from 'node:fs'
import path from 'node:path'
import { denial } from '../../plugins/executor/hooks/policy.mjs'
import { queryDenial } from '../../plugins/executor/hooks/query.mjs'
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

const READ_TOOLS = ['Read', 'Glob', 'Grep']
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'Monitor']
const WORKTREE_TOOLS = ['EnterWorktree', 'ExitWorktree']

/** Whether the project, in its shared checkout or its worktree, declares submodules to prepare. */
export function hasSubmodules(cwd: string, isolationDir: string): boolean {
  return (
    fs.existsSync(path.join(cwd, '.gitmodules')) ||
    fs.existsSync(path.join(isolationDir, '.gitmodules'))
  )
}

/**
 * The reason a tool call must be denied, or null to let it run. Query runs only read; editing
 * runs stay inside their worktree; everything else defers to the executor policy hook.
 */
export function permissionDenial(
  core: Core,
  active: Active,
  input: PermissionInput,
): string | null {
  if (active.readOnly) return readOnlyDenial(core, active, input)
  const cwd = core.store.conversation(active.run.conversation_key)?.cwd ?? core.defaultCwd
  const isolation = isolationFor(cwd, active.run.conversation_key)
  const needsWorkspace = PROJECT_FILE_TOOLS.has(input.tool_name) && !active.workspace

  if (needsWorkspace && hasSubmodules(cwd, isolation.dir)) {
    return 'Espera a que termine la preparacion del proyecto aislado antes de usar herramientas.'
  }

  if (touchesMissingSubmodule(active, input, isolation.dir)) {
    return 'El submodulo no esta inicializado en el proyecto de origen. Prepara su checkout antes de usarlo; no edites un directorio vacio como si fuera el servicio.'
  }

  if (WORKTREE_TOOLS.includes(input.tool_name)) {
    return 'Conserva el aislamiento de esta conversacion; usa regent_use_repo para cambiar de proyecto.'
  }

  if (READ_TOOLS.includes(input.tool_name)) {
    return denial(input, { REGENT_ROOT: isolation.dir, REGENT_CWD: input.cwd ?? isolation.dir })
  }

  if (WRITE_TOOLS.includes(input.tool_name)) return worktreeDenial(core, input, isolation.dir)

  return denial(input, {
    ...process.env,
    REGENT_PERMISSION_MODE: core.config.permission_mode === 'native' ? 'repository' : '',
    REGENT_ROOT: core.cwd,
    REGENT_CWD: cwd,
    REGENT_READONLY_MCP: JSON.stringify(core.config.repos.readonly_mcp),
  })
}

function readOnlyDenial(core: Core, active: Active, input: PermissionInput): string | null {
  const reason = queryDenial(input)
  if (reason) return reason
  const root = active.executionDir ?? core.defaultCwd

  return denial(input, {
    REGENT_ROOT: root,
    REGENT_CWD: input.cwd ?? root,
    REGENT_READ_ONLY: '1',
    REGENT_READONLY_MCP: JSON.stringify(core.config.repos.readonly_mcp),
  })
}

/** An edit aimed at a submodule the origin never initialized would write into an empty directory. */
function touchesMissingSubmodule(
  active: Active,
  input: PermissionInput,
  isolationDir: string,
): boolean {
  const unavailable = active.workspace?.unavailable
  if (!unavailable?.length) return false
  const base = input.cwd ?? isolationDir
  const destinations = [
    input.cwd,
    input.tool_input?.file_path,
    input.tool_input?.notebook_path,
  ].filter((value): value is string => typeof value === 'string')

  return unavailable.some((relative) =>
    destinations.some((destination) =>
      isInside(path.join(isolationDir, relative), path.resolve(base, destination)),
    ),
  )
}

/** Writing tools must run from inside the conversation's worktree, resolved through symlinks. */
function worktreeDenial(core: Core, input: PermissionInput, isolationDir: string): string | null {
  try {
    const root = fs.realpathSync(isolationDir)
    if (root !== isolationDir) return 'El directorio aislado no puede ser un enlace simbolico.'
    const actual = fs.realpathSync(input.cwd ?? isolationDir)

    if (!isInside(root, actual)) {
      return 'Ejecuta las herramientas dentro del worktree de esta conversacion.'
    }

    return denial(input, {
      REGENT_ROOT: root,
      REGENT_CWD: actual,
      REGENT_READONLY_MCP: JSON.stringify(core.config.repos.readonly_mcp),
    })
  } catch {
    return 'No hay un worktree aislado disponible. Selecciona un repo Git con regent_use_repo; no edites el checkout compartido.'
  }
}
