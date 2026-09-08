import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { Effects } from './effects.ts'
import { hash, command as runCommand } from './changes.ts'
import type { Store } from './store.ts'

const exec = promisify(execFile)
const Manifest = z.object({ profiles: z.record(z.string(), z.object({
  command: z.array(z.string().min(1)).min(1),
}).strict()) }).strict()

export class Projects {
  root: string
  effects: Effects
  constructor(store: Store, root: string) { this.root = fs.realpathSync(root); this.effects = new Effects(store) }
  inside(dir: string): string {
    const relative = path.relative(this.root, dir)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('El proyecto debe estar dentro del workspace autorizado.')
    return dir
  }
  repo(value: string): string {
    const dir = this.inside(fs.realpathSync(path.resolve(this.root, value)))
    if (!fs.statSync(dir).isDirectory() || !fs.existsSync(path.join(dir, '.git'))) throw new Error('Indica la raiz de un repositorio existente.')
    return dir
  }
  profiles(source: string) {
    const file = path.join(this.repo(source), '.regent', 'projects.json')
    if (!fs.existsSync(file)) return {}
    this.inside(fs.realpathSync(file))
    return Manifest.parse(JSON.parse(fs.readFileSync(file, 'utf8'))).profiles
  }
  async create(source: string, profile: string, destination: string, input: Record<string, string>, env: NodeJS.ProcessEnv, signal: AbortSignal) {
    const origin = this.repo(source)
    const definition = this.profiles(origin)[profile]
    if (!definition) throw new Error('Perfil inexistente en .regent/projects.json del repo de contexto.')
    const requested = path.resolve(this.root, destination)
    const parent = this.inside(fs.realpathSync(path.dirname(requested)))
    for (let ancestor = parent; ; ancestor = path.dirname(ancestor)) {
      if (fs.existsSync(path.join(ancestor, '.git'))) throw new Error('Un proyecto independiente no debe crearse dentro de otro repositorio.')
      if (ancestor === this.root) break
    }
    const dir = this.inside(path.join(parent, path.basename(requested)))
    if (dir === this.root) throw new Error('No se puede provisionar la raiz del workspace.')
    const inspect = async () => {
      if (fs.realpathSync(dir) !== dir) throw new Error('El destino no puede ser un enlace simbolico.')
      this.repo(dir)
      await exec('git', ['rev-parse', '--verify', 'HEAD'], { cwd: dir, env, signal, timeout: 10000 })
      await exec('git', ['remote', 'get-url', 'origin'], { cwd: dir, env, signal, timeout: 10000 })
      const branch = (await exec('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: dir, env, signal, timeout: 10000 })).stdout.trim()
      await exec('git', ['rev-parse', '--verify', `refs/remotes/origin/${branch}`], { cwd: dir, env, signal, timeout: 10000 })
      return { repo: dir, profile }
    }
    // One target, one creation, even across conversations or restarts. Never rerun
    // a provider after an uncertain result merely because a local checkout is absent.
    const key = `project:${hash(dir)}`
    const prior = this.effects.store.db.prepare('SELECT state FROM effects WHERE key=?').get(key)
    if (!prior && fs.existsSync(dir)) throw new Error('El destino ya existe; usa regent_use_repo o elige otro nombre.')
    return this.effects.once(key, async () => {
      fs.mkdirSync(dir)
      const [command, ...args] = definition.command
      await runCommand(command, args, origin, signal, { ...env, REGENT_PROJECT_DIR: dir, REGENT_PROJECT_INPUT: JSON.stringify(input) })
      return inspect()
    }, async () => undefined)
  }
}
