import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { isolationFor, projectRoot } from './repository.ts'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 16 * 1024 * 1024,
}).trimEnd()

const inside = (root: string, file: string) => {
  const relative = path.relative(root, file)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function commonDir(repo: string): string {
  return fs.realpathSync(path.resolve(repo, git(repo, 'rev-parse', '--git-common-dir')))
}

function assertWorktree(source: string, target: string): void {
  if (fs.realpathSync(target) !== target || fs.realpathSync(source) === target
    || fs.realpathSync(git(target, 'rev-parse', '--show-toplevel')) !== target
    || commonDir(source) !== commonDir(target)) throw new Error('El checkout aislado no corresponde al repositorio de origen.')
}

function ensureDirectory(root: string, directory: string): void {
  let ancestor = directory
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor)
  if (!inside(root, fs.realpathSync(ancestor))) throw new Error('Directorio enlazado fuera del worktree.')
  fs.mkdirSync(directory, { recursive: true })
  if (!inside(root, fs.realpathSync(directory))) throw new Error('Directorio fuera del worktree.')
}

function copySetupFiles(source: string, target: string): void {
  if (!fs.existsSync(path.join(source, '.worktreeinclude'))) return
  const files = git(source, 'ls-files', '--others', '--ignored', '--exclude-from=.worktreeinclude', '-z').split('\0').filter(Boolean)
  for (const file of files) {
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

export function prepareProjectWorkspace(workspace: string, project: string, directory: string, conversation: string): ProjectWorkspace {
  const result: ProjectWorkspace = { submodules: [], unavailable: [] }
  assertWorktree(project, directory)
  const visit = (source: string, target: string) => {
    const entries = git(target, 'ls-files', '--stage', '-z').split('\0').filter(entry => entry.startsWith('160000 '))
    const registered = new Set(fs.existsSync(path.join(target, '.gitmodules'))
      ? git(target, 'config', '--null', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$').split('\0').filter(Boolean).map(entry => entry.slice(entry.indexOf('\n') + 1))
      : [])
    for (const entry of entries) {
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
        try { git(original, 'worktree', 'add', '-b', branch, isolated, commit) }
        catch { throw new Error(`No se pudo preparar el submodulo ${JSON.stringify(label)}. Verifica el commit fijado y sus worktrees; no se modifico el checkout compartido.`) }
        copySetupFiles(original, isolated)
      }
      assertWorktree(original, isolated)
      result.submodules.push(label)
      visit(original, isolated)
    }
  }
  visit(project, directory)
  return result
}
