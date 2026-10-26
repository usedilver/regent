import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isInside, isolationFor, projectRoot } from './repository.ts'

const execute = promisify(execFile)
const GIT_TIMEOUT_MS = 30000
const GIT_OUTPUT_BYTES = 16 * 1024 * 1024
const GITLINK = /^160000 ([0-9a-f]+) ([0-3])\t([\s\S]+)$/
const CREDENTIAL_FILES = /(?:^|\/)\.credentials\.json$|(?:^|\/)\.claude\.json$/

const git = async (cwd: string, args: string[], signal?: AbortSignal) =>
  (
    await execute('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_OUTPUT_BYTES,
      signal,
    })
  ).stdout.trimEnd()

export interface ProjectWorkspace {
  submodules: string[]
  unavailable: string[]
}

interface Gitlink {
  path: string
  commit: string
}

async function commonDir(repo: string, signal?: AbortSignal): Promise<string> {
  return fs.realpathSync(
    path.resolve(repo, await git(repo, ['rev-parse', '--git-common-dir'], signal)),
  )
}

/** The target is a real worktree of the source repository, not a symlink or the source itself. */
async function assertWorktree(source: string, target: string, signal?: AbortSignal): Promise<void> {
  if (
    fs.realpathSync(target) !== target ||
    fs.realpathSync(source) === target ||
    fs.realpathSync(await git(target, ['rev-parse', '--show-toplevel'], signal)) !== target ||
    (await commonDir(source, signal)) !== (await commonDir(target, signal))
  ) {
    throw new Error('El checkout aislado no corresponde al repositorio de origen.')
  }
}

function ensureDirectory(root: string, directory: string): void {
  let ancestor = directory
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor)

  if (!isInside(root, fs.realpathSync(ancestor))) {
    throw new Error('Directorio enlazado fuera del worktree.')
  }

  fs.mkdirSync(directory, { recursive: true })
  if (!isInside(root, fs.realpathSync(directory))) throw new Error('Directorio fuera del worktree.')
}

/** Ignored files the repo lists in .worktreeinclude (local env, certificates) copied once. */
async function copySetupFiles(source: string, target: string, signal?: AbortSignal): Promise<void> {
  if (!fs.existsSync(path.join(source, '.worktreeinclude'))) return
  const files = (
    await git(
      source,
      ['ls-files', '--others', '--ignored', '--exclude-from=.worktreeinclude', '-z'],
      signal,
    )
  )
    .split('\0')
    .filter(Boolean)

  for (const file of files) {
    signal?.throwIfAborted()
    const original = path.join(source, file)
    const destination = path.join(target, file)

    if (!isInside(source, fs.realpathSync(original)) || CREDENTIAL_FILES.test(file)) {
      throw new Error('Archivo de setup fuera del proyecto o reservado para credenciales.')
    }

    if (fs.existsSync(destination)) continue
    ensureDirectory(target, path.dirname(destination))
    fs.copyFileSync(original, destination, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(destination, fs.statSync(original).mode & 0o777)
  }
}

/** The checkout's gitlinks: each submodule path with the commit the superproject pins. */
async function gitlinks(target: string, signal?: AbortSignal): Promise<Gitlink[]> {
  const entries = (await git(target, ['ls-files', '--stage', '-z'], signal))
    .split('\0')
    .filter((entry) => entry.startsWith('160000 '))

  return entries.map((entry) => {
    const match = GITLINK.exec(entry)

    if (!match || match[2] !== '0') {
      throw new Error('Resuelve el conflicto de gitlinks antes de preparar los submodulos.')
    }

    return { commit: match[1], path: match[3] }
  })
}

async function registeredSubmodules(target: string, signal?: AbortSignal): Promise<Set<string>> {
  if (!fs.existsSync(path.join(target, '.gitmodules'))) return new Set()
  const output = await git(
    target,
    ['config', '--null', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'],
    signal,
  )

  return new Set(
    output
      .split('\0')
      .filter(Boolean)
      .map((entry) => entry.slice(entry.indexOf('\n') + 1)),
  )
}

/** Adds the submodule's worktree at the pinned commit, once, and verifies it either way. */
async function materialize(
  original: string,
  isolated: string,
  commit: string,
  branch: string,
  label: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!fs.existsSync(path.join(isolated, '.git'))) {
    const occupied =
      fs.existsSync(isolated) &&
      (fs.lstatSync(isolated).isSymbolicLink() || fs.readdirSync(isolated).length)

    if (occupied) throw new Error('El destino del submodulo contiene archivos; no se reemplazara.')

    try {
      await git(original, ['worktree', 'add', '-b', branch, isolated, commit], signal)
    } catch {
      throw new Error(
        `No se pudo preparar el submodulo ${JSON.stringify(label)}. Verifica el commit fijado y sus worktrees; no se modifico el checkout compartido.`,
      )
    }

    await copySetupFiles(original, isolated, signal)
  }

  await assertWorktree(original, isolated, signal)
}

/**
 * Mirrors the project's submodules, recursively, into the conversation's worktree as worktrees
 * of their own. Submodules the origin never initialized are reported, not fabricated.
 */
export async function prepareProjectWorkspace(
  workspace: string,
  project: string,
  directory: string,
  conversation: string,
  signal?: AbortSignal,
): Promise<ProjectWorkspace> {
  const result: ProjectWorkspace = { submodules: [], unavailable: [] }
  await assertWorktree(project, directory, signal)

  const visit = async (source: string, target: string): Promise<void> => {
    const links = await gitlinks(target, signal)
    if (!links.length) return
    const registered = await registeredSubmodules(target, signal)

    for (const link of links) {
      signal?.throwIfAborted()
      const original = path.join(source, link.path)
      const isolated = path.join(target, link.path)
      const label = path.relative(directory, isolated)

      if (!isInside(project, original) || !isInside(directory, isolated)) {
        throw new Error('Ruta de submodulo fuera del proyecto.')
      }

      if (!registered.has(link.path) || !fs.existsSync(path.join(original, '.git'))) {
        result.unavailable.push(label)
        continue
      }

      if (projectRoot(workspace, original) !== project) {
        throw new Error('El submodulo no pertenece al proyecto seleccionado.')
      }

      ensureDirectory(directory, path.dirname(isolated))
      const branch = isolationFor(original, conversation).name
      await materialize(original, isolated, link.commit, branch, label, signal)
      result.submodules.push(label)
      await visit(original, isolated)
    }
  }

  await visit(project, directory)
  return result
}
