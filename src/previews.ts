import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { inspectProcess, ownsListener } from './preview-process.ts'
export { inspectProcess } from './preview-process.ts'
import { z } from 'zod'
import type { Config } from './config.ts'
import type { Store } from './store.ts'

export const PreviewRequest = z.object({
  action: z.enum(['reserve', 'publish', 'status', 'stop']),
  pid: z.number().int().positive().optional(),
})
export type Preview = {
  id: string
  conversation_key: string
  port: number
  cwd: string
  pid: number | null
  process_start: string | null
  expires_at: number
}
const inside = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
const freePort = (port: number) =>
  new Promise<boolean>((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })

export class Previews {
  private timer?: ReturnType<typeof setInterval>
  private pending = Promise.resolve()
  readonly store: Store
  readonly config: NonNullable<Config['previews']>
  private inspect: typeof inspectProcess
  private kill: (pid: number, signal: NodeJS.Signals) => unknown
  private now: () => number
  private listener: typeof ownsListener
  constructor(
    store: Store,
    config: NonNullable<Config['previews']>,
    inspect = inspectProcess,
    kill: (pid: number, signal: NodeJS.Signals) => unknown = (pid, signal) =>
      process.kill(-pid, signal),
    now = Date.now,
    listener = ownsListener,
  ) {
    this.store = store
    this.config = config
    this.inspect = inspect
    this.kill = kill
    this.now = now
    this.listener = listener
  }
  start(): void {
    this.expire()
    this.timer = setInterval(() => this.expire(), 30000)
    this.timer.unref()
  }
  close(): void {
    clearInterval(this.timer)
  }
  get(key: string): Preview | undefined {
    return this.store.db
      .prepare('SELECT * FROM previews WHERE conversation_key=?')
      .get(key) as unknown as Preview | undefined
  }
  ownsProcess(preview: Preview): boolean {
    if (!preview.pid) return false
    const current = this.inspect(preview.pid)
    return Boolean(
      current &&
        current.start === preview.process_start &&
        current.group === preview.pid &&
        inside(preview.cwd, current.cwd),
    )
  }
  private remove(preview: Preview): void {
    if (this.ownsProcess(preview)) {
      try {
        this.kill(preview.pid!, 'SIGTERM')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
      const cleanup = setTimeout(() => {
        if (this.ownsProcess(preview)) {
          try {
            this.kill(preview.pid!, 'SIGKILL')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
              console.error('[preview] Process cleanup failed')
          }
        }
      }, 5000)
      cleanup.unref()
    }
    this.store.db.prepare('DELETE FROM previews WHERE id=?').run(preview.id)
  }
  expire(): void {
    for (const row of this.store.db
      .prepare('SELECT * FROM previews WHERE expires_at<=?')
      .all(this.now())) {
      try {
        this.remove(row as unknown as Preview)
      } catch (error) {
        console.error('[preview] Cleanup failed:', (error as Error).name)
      }
    }
  }
  result(preview: Preview) {
    return {
      url: `https://r-${preview.id}.${this.config.domain}`,
      port: preview.port,
      cwd: preview.cwd,
      expires_at: new Date(preview.expires_at).toISOString(),
      ready: Boolean(
        preview.expires_at > this.now() &&
          preview.pid &&
          this.ownsProcess(preview) &&
          this.listener(preview.port, preview.pid, preview.cwd),
      ),
    }
  }
  async reserve(key: string, directory: string) {
    let release!: () => void
    const previous = this.pending
    this.pending = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      this.expire()
      const cwd = fs.realpathSync(directory)
      const existing = this.get(key)
      if (existing) {
        if (existing.cwd !== cwd)
          throw new Error('Deten el preview anterior antes de cambiar de proyecto.')
        this.store.db
          .prepare('UPDATE previews SET expires_at=? WHERE id=?')
          .run(this.now() + this.config.ttl_minutes * 60000, existing.id)
        return this.result(this.get(key)!)
      }
      const count = this.store.db.prepare('SELECT COUNT(*) AS n FROM previews').get()!.n as number
      if (count >= this.config.max_active)
        throw new Error(
          'Se alcanzo el limite de previews activos; detiene uno o espera su vencimiento.',
        )
      const used = new Set(
        this.store.db
          .prepare('SELECT port FROM previews')
          .all()
          .map((row) => row.port),
      )
      for (let port = this.config.port_min; port <= this.config.port_max; port++) {
        if (used.has(port) || !(await freePort(port))) continue
        const id = randomBytes(8).toString('hex')
        this.store.db
          .prepare(
            'INSERT INTO previews(id,conversation_key,port,cwd,expires_at) VALUES(?,?,?,?,?)',
          )
          .run(id, key, port, cwd, this.now() + this.config.ttl_minutes * 60000)
        return this.result(this.get(key)!)
      }
      throw new Error('No hay puertos de preview disponibles.')
    } finally {
      release()
    }
  }
  async publish(key: string, pid: number) {
    const preview = this.get(key)
    if (!preview || preview.expires_at <= this.now())
      throw new Error('Reserva un preview antes de publicarlo.')
    if (preview.pid !== pid && this.ownsProcess(preview))
      throw new Error('Deten el preview activo antes de reemplazar su proceso.')
    const process = this.inspect(pid)
    if (!process || process.group !== pid || !inside(preview.cwd, process.cwd))
      throw new Error('El PID debe ser un proceso independiente del worktree de esta conversacion.')
    if (!this.listener(preview.port, pid, preview.cwd))
      throw new Error('El listener del puerto no pertenece al proceso del preview.')
    const response = await fetch(`http://127.0.0.1:${preview.port}/`, {
      headers: { connection: 'close' },
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    })
    await response.body?.cancel()
    if (response.status >= 500) throw new Error('La aplicacion todavia no responde correctamente.')
    const current = this.inspect(pid)
    if (
      !current ||
      current.start !== process.start ||
      current.group !== pid ||
      !inside(preview.cwd, current.cwd)
    )
      throw new Error('El proceso del preview cambio durante la verificacion.')
    if (!this.listener(preview.port, pid, preview.cwd))
      throw new Error('El listener del preview cambio durante la verificacion.')
    this.store.db
      .prepare('UPDATE previews SET pid=?,process_start=? WHERE id=?')
      .run(pid, process.start, preview.id)
    return this.result(this.get(key)!)
  }
  stop(key: string) {
    const preview = this.get(key)
    if (preview) this.remove(preview)
    return { stopped: true }
  }
  resolve(host: string): Preview | undefined {
    const suffix = `.${this.config.domain}`
    if (!host.endsWith(suffix)) return
    const id = host.slice(0, -suffix.length)
    if (!/^r-[a-f0-9]{16}$/.test(id)) return
    const preview = this.store.db
      .prepare('SELECT * FROM previews WHERE id=? AND expires_at>?')
      .get(id.slice(2), this.now()) as unknown as Preview | undefined
    return preview &&
      this.ownsProcess(preview) &&
      this.listener(preview.port, preview.pid!, preview.cwd)
      ? preview
      : undefined
  }
}
