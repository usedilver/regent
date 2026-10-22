import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isolationFor, projectRoot } from './repository.ts'

const execute = promisify(execFile)
const GIT_TIMEOUT_MS = 30000
const GIT_OUTPUT_BYTES = 16 * 1024 * 1024
const git = async (cwd: string, args: string[], signal?: AbortSignal) => (await execute('git', args, {
  cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_BYTES, signal,
})).stdout.trimEnd()

const inside = (root: string, file: string) => {
  const relative = path.relative(root, file)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function commonDir(repo: string, signal?: AbortSignal): Promise<string> {
  return fs.realpathSync(path.resolve(repo, await git(repo, ['rev-parse', '--git-common-dir'], signal)))
}

async function assertWorktree(source: string, target: string, signal?: AbortSignal): Promise<void> {
  if (fs.realpathSync(target) !== target || fs.realpathSync(source) === target
    || fs.realpathSync(await git(target, ['rev-parse', '--show-toplevel'], signal)) !== target
    || await commonDir(source, signal) !== await commonDir(target, signal)) throw new Error('El checkout aislado no corresponde al repositorio de origen.')
}

function ensureDirectory(root: string, directory: string): void {
  let ancestor = directory
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor)
  if (!inside(root, fs.realpathSync(ancestor))) throw new Error('Directorio enlazado fuera del worktree.')
  fs.mkdirSync(directory, { recursive: true })
  if (!inside(root, fs.realpathSync(directory))) throw new Error('Directorio fuera del worktree.')
}

async function copySetupFiles(source: string, target: string, signal?: AbortSignal): Promise<void> {
  if (!fs.existsSync(path.join(source, '.worktreeinclude'))) return
  const files = (await git(source, ['ls-files', '--others', '--ignored', '--exclude-from=.worktreeinclude', '-z'], signal)).split('\0').filter(Boolean)
  for (const file of files) {
    signal?.throwIfAborted()
    const original = path.join(source, file), destination = path.join(target, file)
    if (!inside(source, fs.realpathSync(original)) || /(?:^|\/)\.credentials\.json$|(?:^|\/)\.claude\.json$/.test(file)) throw new Error('Archivo de setup fuera del proyecto o reservado para credenciales.')
    if (fs.existsSync(destination)) continue
    ensureDirectory(target, path.dirname(destination))
    fs.copyFileSync(original, destination, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(destination, fs.statSync(original).mode & 0o777)
  }
}

export interface ProjectWorkspace {
  submodules: string[]
  unavailable: string[]
}

export async function prepareProjectWorkspace(workspace: string, project: string, directory: string, conversation: string, signal?: AbortSignal): Promise<ProjectWorkspace> {
  const result: ProjectWorkspace = { submodules: [], unavailable: [] }
  await assertWorktree(project, directory, signal)
  const visit = async (source: string, target: string): Promise<void> => {
    const entries = (await git(target, ['ls-files', '--stage', '-z'], signal)).split('\0').filter(entry => entry.startsWith('160000 '))
    if (!entries.length) return
    const registered = new Set(fs.existsSync(path.join(target, '.gitmodules'))
      ? (await git(target, ['config', '--null', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'], signal)).split('\0').filter(Boolean).map(entry => entry.slice(entry.indexOf('\n') + 1))
      : [])
    for (const entry of entries) {
      signal?.throwIfAborted()
      const match = /^160000 ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(entry)
      if (!match || match[2] !== '0') throw new Error('Resuelve el conflicto de gitlinks antes de preparar los submodulos.')
      const [, commit, , relative] = match
      const original = path.join(source, relative), isolated = path.join(target, relative)
      const label = path.relative(directory, isolated)
      if (!inside(project, original) || !inside(directory, isolated)) throw new Error('Ruta de submodulo fuera del proyecto.')
      if (!registered.has(relative) || !fs.existsSync(path.join(original, '.git'))) { result.unavailable.push(label); continue }
      if (projectRoot(workspace, original) !== project) throw new Error('El submodulo no pertenece al proyecto seleccionado.')
      ensureDirectory(directory, path.dirname(isolated))
      if (!fs.existsSync(path.join(isolated, '.git'))) {
        if (fs.existsSync(isolated) && (fs.lstatSync(isolated).isSymbolicLink() || fs.readdirSync(isolated).length)) throw new Error('El destino del submodulo contiene archivos; no se reemplazara.')
        const branch = isolationFor(original, conversation).name
        try { await git(original, ['worktree', 'add', '-b', branch, isolated, commit], signal) }
        catch { throw new Error(`No se pudo preparar el submodulo ${JSON.stringify(label)}. Verifica el commit fijado y sus worktrees; no se modifico el checkout compartido.`) }
        await copySetupFiles(original, isolated, signal)
      }
      await assertWorktree(original, isolated, signal)
      result.submodules.push(label)
      await visit(original, isolated)
    }
  }
  await visit(project, directory)
  return result
}
