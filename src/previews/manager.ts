import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { inspectProcess, ownsListener, type ProcessInfo } from './process.ts'
import { isInside } from '../core/repository.ts'

export { inspectProcess } from './process.ts'

import { z } from 'zod'
import type { Config } from '../config.ts'
import type { Store } from '../storage/store.ts'

export const PreviewRequest = z.object({
  action: z.enum(['reserve', 'start', 'publish', 'status', 'stop']),
  pid: z.number().int().positive().optional(),
  directory: z.string().min(1).max(2000).default('.'),
  command: z.array(z.string().min(1).max(2000)).min(1).max(80).optional(),
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

const EXPIRE_EVERY_MS = 30000
const KILL_AFTER_MS = 5000
const PUBLISH_TIMEOUT_MS = 5000

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
    this.timer = setInterval(() => this.expire(), EXPIRE_EVERY_MS)
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

  /** The inspected process is the recorded one: same start, its own group, inside the worktree. */
  private sameProcess(
    current: ProcessInfo | null,
    pid: number,
    start: string | null,
    cwd: string,
  ): boolean {
    if (!current) return false
    return current.start === start && current.group === pid && isInside(cwd, current.cwd)
  }

  ownsProcess(preview: Preview): boolean {
    if (!preview.pid) return false
    const current = this.inspect(preview.pid)
    return this.sameProcess(current, preview.pid, preview.process_start, preview.cwd)
  }

  private signal(preview: Preview, sig: NodeJS.Signals): void {
    try {
      this.kill(preview.pid!, sig)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }

  /** SIGTERM now, SIGKILL in a few seconds if the preview's process is still around. */
  private terminate(preview: Preview): void {
    this.signal(preview, 'SIGTERM')
    const cleanup = setTimeout(() => {
      if (!this.ownsProcess(preview)) return

      try {
        this.signal(preview, 'SIGKILL')
      } catch {
        console.error('[preview] Process cleanup failed')
      }
    }, KILL_AFTER_MS)

    cleanup.unref()
  }

  private remove(preview: Preview): void {
    if (this.ownsProcess(preview)) this.terminate(preview)
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

  private expiresAt(): number {
    return this.now() + this.config.ttl_minutes * 60000
  }

  private renew(existing: Preview, cwd: string) {
    if (existing.cwd !== cwd) {
      throw new Error('Deten el preview anterior antes de cambiar de proyecto.')
    }

    this.store.db
      .prepare('UPDATE previews SET expires_at=? WHERE id=?')
      .run(this.expiresAt(), existing.id)
    return this.result(this.get(existing.conversation_key)!)
  }

  /** The first free port in the configured range that no other preview already holds. */
  private async allocate(key: string, cwd: string) {
    const count = this.store.db.prepare('SELECT COUNT(*) AS n FROM previews').get()!.n as number

    if (count >= this.config.max_active) {
      throw new Error(
        'Se alcanzo el limite de previews activos; detiene uno o espera su vencimiento.',
      )
    }

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
        .prepare('INSERT INTO previews(id,conversation_key,port,cwd,expires_at) VALUES(?,?,?,?,?)')
        .run(id, key, port, cwd, this.expiresAt())
      return this.result(this.get(key)!)
    }

    throw new Error('No hay puertos de preview disponibles.')
  }

  /** Reservations run one at a time, so two conversations never probe the same port together. */
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
      return existing ? this.renew(existing, cwd) : await this.allocate(key, cwd)
    } finally {
      release()
    }
  }

  async publish(key: string, pid: number) {
    const preview = this.get(key)

    if (!preview || preview.expires_at <= this.now()) {
      throw new Error('Reserva un preview antes de publicarlo.')
    }

    if (preview.pid !== pid && this.ownsProcess(preview)) {
      throw new Error('Deten el preview activo antes de reemplazar su proceso.')
    }

    const process = this.inspect(pid)

    if (!process || process.group !== pid || !isInside(preview.cwd, process.cwd)) {
      throw new Error('El PID debe ser un proceso independiente del worktree de esta conversacion.')
    }

    if (!this.listener(preview.port, pid, preview.cwd)) {
      throw new Error('El listener del puerto no pertenece al proceso del preview.')
    }

    const response = await fetch(`http://127.0.0.1:${preview.port}/`, {
      headers: { connection: 'close' },
      redirect: 'manual',
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    })

    await response.body?.cancel()
    if (response.status >= 500) throw new Error('La aplicacion todavia no responde correctamente.')

    if (!this.sameProcess(this.inspect(pid), pid, process.start, preview.cwd)) {
      throw new Error('El proceso del preview cambio durante la verificacion.')
    }

    if (!this.listener(preview.port, pid, preview.cwd)) {
      throw new Error('El listener del preview cambio durante la verificacion.')
    }

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
