import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isInside, isolationFor, projectRoot } from './repository.ts'

const execute = promisify(execFile)
const GIT_TIMEOUT_MS = 30000
const GIT_OUTPUT_BYTES = 16 * 1024 * 1024
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000
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

/** Submodule paths relative to the conversation worktree. */
export interface ProjectWorkspace {
  /** Checked out in the worktree. */
  submodules: string[]
  /** Registered but never initialized in the source checkout. */
  unavailable: string[]
  /** Available in the source checkout but not yet checked out in the worktree. */
  pending: string[]
}

/** `read` only inspects; `refresh` also copies newly provisioned setup files into checkouts. */
export type ScanMode = 'read' | 'refresh'

interface Gitlink {
  path: string
  commit: string
}

async function commonDir(repo: string, signal?: AbortSignal): Promise<string> {
  return fs.realpathSync(
    path.resolve(repo, await git(repo, ['rev-parse', '--git-common-dir'], signal)),
  )
}

async function assertRepositoryWorktree(
  repository: string,
  target: string,
  signal?: AbortSignal,
): Promise<void> {
  if (
    fs.realpathSync(target) !== target ||
    fs.realpathSync(await git(target, ['rev-parse', '--show-toplevel'], signal)) !== target ||
    repository !== (await commonDir(target, signal))
  ) {
    throw new Error('El checkout aislado no corresponde al repositorio de origen.')
  }
}

/** The target is a real worktree of the source repository, not a symlink or the source itself. */
async function assertWorktree(source: string, target: string, signal?: AbortSignal): Promise<void> {
  if (fs.realpathSync(source) === target) {
    throw new Error('El checkout aislado no corresponde al repositorio de origen.')
  }
  await assertRepositoryWorktree(await commonDir(source, signal), target, signal)
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

/** A pnpm project gets its dependencies once, so the executor can run its checks and app. */
async function installDependencies(
  target: string,
  label: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!fs.existsSync(path.join(target, 'pnpm-lock.yaml'))) return
  if (fs.existsSync(path.join(target, 'node_modules'))) return

  try {
    await execute('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], {
      cwd: target,
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: GIT_OUTPUT_BYTES,
      signal,
    })
  } catch {
    fs.rmSync(path.join(target, 'node_modules'), { recursive: true, force: true })
    throw new Error(
      `El submodulo ${JSON.stringify(label)} quedo listo, pero fallo pnpm install. Ejecutalo en el submodulo antes de correr sus checks.`,
    )
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

async function registeredSubmodules(
  target: string,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  if (!fs.existsSync(path.join(target, '.gitmodules'))) return new Map()
  const output = await git(
    target,
    ['config', '--null', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'],
    signal,
  )

  return new Map(
    output
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf('\n')
        return [
          entry.slice(separator + 1),
          entry.slice('submodule.'.length, separator - '.path'.length),
        ]
      }),
  )
}

/** Adds the submodule's worktree at the pinned commit, once, and verifies it either way. */
async function materialize(
  child: Submodule,
  conversation: string,
  signal?: AbortSignal,
): Promise<void> {
  const { original, isolated, repository, commit, label } = child
  if (!repository) throw new Error('No se encontro el repositorio de origen del submodulo.')

  if (!fs.existsSync(path.join(isolated, '.git'))) {
    const occupied =
      fs.existsSync(isolated) &&
      (fs.lstatSync(isolated).isSymbolicLink() || fs.readdirSync(isolated).length)

    if (occupied) throw new Error('El destino del submodulo contiene archivos; no se reemplazara.')

    try {
      const branch = isolationFor(original, conversation).name
      await git(original, ['worktree', 'add', '-b', branch, isolated, commit], signal)
    } catch {
      throw new Error(
        `No se pudo preparar el submodulo ${JSON.stringify(label)}. Verifica el commit fijado y sus worktrees; no se modifico el checkout compartido.`,
      )
    }
  }

  await assertRepositoryWorktree(repository, isolated, signal)
  if (child.sourceAvailable) await copySetupFiles(original, isolated, signal)
  await installDependencies(isolated, label, signal)
}

interface Submodule extends Gitlink {
  original: string
  isolated: string
  repository: string | null
  sourceAvailable: boolean
  label: string
  available: boolean
}

/** Submodule ownership comes from the isolated parent's registration and Git storage. */
async function submoduleRepository(
  workspace: string,
  project: string,
  parentCommon: string,
  original: string,
  name: string | undefined,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!name) return null
  const modules = path.join(parentCommon, 'modules')
  const expected = path.resolve(modules, name)
  if (expected === modules || !isInside(modules, expected)) {
    throw new Error('Ruta de repositorio de submodulo fuera del proyecto.')
  }

  if (fs.existsSync(expected)) {
    const repository = fs.realpathSync(expected)
    if (!isInside(parentCommon, repository)) {
      throw new Error('Repositorio de submodulo enlazado fuera del proyecto.')
    }
    return repository
  }

  // Older, unabsorbed submodules keep their Git directory inside the source checkout.
  const localGit = path.join(original, '.git')
  if (
    fs.existsSync(localGit) &&
    fs.realpathSync(original) === original &&
    fs.lstatSync(localGit).isDirectory() &&
    projectRoot(workspace, original) === project
  ) {
    return commonDir(original, signal)
  }

  return null
}

/** The submodules one checkout level declares, mapped onto the source and the worktree. */
async function submodulesOf(
  workspace: string,
  project: string,
  directory: string,
  source: string,
  target: string,
  signal?: AbortSignal,
): Promise<Submodule[]> {
  const links = await gitlinks(target, signal)
  if (!links.length) return []
  const registered = await registeredSubmodules(target, signal)
  const parentCommon = await commonDir(target, signal)

  return Promise.all(
    links.map(async (link) => {
      const original = path.join(source, link.path)
      const isolated = path.join(target, link.path)

      if (!isInside(project, original) || !isInside(directory, isolated)) {
        throw new Error('Ruta de submodulo fuera del proyecto.')
      }

      const repository = await submoduleRepository(
        workspace,
        project,
        parentCommon,
        original,
        registered.get(link.path),
        signal,
      )
      const sourceAvailable = Boolean(
        repository &&
          fs.existsSync(path.join(original, '.git')) &&
          fs.realpathSync(original) === original &&
          (await commonDir(original, signal)) === repository,
      )
      const available = Boolean(
        repository && (sourceAvailable || fs.existsSync(path.join(isolated, '.git'))),
      )

      return {
        ...link,
        original,
        isolated,
        repository,
        sourceAvailable,
        label: path.relative(directory, isolated),
        available,
      }
    }),
  )
}

/**
 * Inventories the project's submodules inside the conversation's worktree without creating
 * checkouts. Existing ones are verified and descended into; the rest stay pending.
 */
export async function scanProjectWorkspace(
  workspace: string,
  project: string,
  directory: string,
  mode: ScanMode,
  signal?: AbortSignal,
): Promise<ProjectWorkspace> {
  const result: ProjectWorkspace = { submodules: [], unavailable: [], pending: [] }
  await assertWorktree(project, directory, signal)

  const visit = async (source: string, target: string): Promise<void> => {
    for (const child of await submodulesOf(workspace, project, directory, source, target, signal)) {
      signal?.throwIfAborted()

      if (!child.available || !child.repository) {
        result.unavailable.push(child.label)
        continue
      }

      if (!fs.existsSync(path.join(child.isolated, '.git'))) {
        result.pending.push(child.label)
        continue
      }

      await assertRepositoryWorktree(child.repository, child.isolated, signal)
      if (mode === 'refresh' && child.sourceAvailable)
        await copySetupFiles(child.original, child.isolated, signal)
      result.submodules.push(child.label)
      await visit(child.original, child.isolated)
    }
  }

  await visit(project, directory)
  return result
}

/**
 * Checks out, at the parent's pinned commits, the submodule that contains `destination` and
 * every enclosing submodule. Returns the checkouts it verified, outermost first.
 */
export async function prepareSubmodule(
  workspace: string,
  project: string,
  directory: string,
  conversation: string,
  destination: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const target = path.resolve(directory, destination)
  if (!isInside(directory, target)) throw new Error('Ruta de submodulo fuera del proyecto.')
  await assertWorktree(project, directory, signal)
  const prepared: string[] = []
  let source = project
  let parent = directory

  while (true) {
    signal?.throwIfAborted()
    const children = await submodulesOf(workspace, project, directory, source, parent, signal)
    const child = children.find((candidate) => isInside(candidate.isolated, target))
    if (!child) return prepared

    if (!child.available) {
      throw new Error(
        `El submodulo ${JSON.stringify(child.label)} no esta inicializado en el proyecto de origen.`,
      )
    }

    ensureDirectory(directory, path.dirname(child.isolated))
    await materialize(child, conversation, signal)
    prepared.push(child.label)
    source = child.original
    parent = child.isolated
  }
}
