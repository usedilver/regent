import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { inspectProcess, type Previews } from './manager.ts'
import { isInside } from '../core/repository.ts'

const launches = new WeakMap<Previews, Set<string>>()

/** The runtime owns this process, independently of the CLI's temporary Bash tasks. */
export async function launchPreview(
  previews: Previews,
  key: string,
  directory: string,
  command: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
) {
  const pending = launches.get(previews) ?? new Set<string>()
  launches.set(previews, pending)
  if (pending.has(key)) throw new Error('El preview ya esta arrancando; espera su resultado.')
  pending.add(key)
  try {
    return await start(previews, key, directory, command, env, signal)
  } finally {
    pending.delete(key)
  }
}

async function start(
  previews: Previews,
  key: string,
  directory: string,
  command: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
) {
  const preview = previews.get(key)
  if (!preview) throw new Error('Reserva primero el puerto del preview.')
  if (previews.ownsProcess(preview))
    throw new Error('El preview ya tiene un proceso; reutilizalo o detenlo primero.')
  const cwd = fs.realpathSync(directory)
  if (!isInside(preview.cwd, cwd)) throw new Error('Inicia la app dentro del worktree reservado.')
  const logDirectory = path.join(os.tmpdir(), `regent-previews-${process.getuid?.() ?? 'local'}`)
  fs.mkdirSync(logDirectory, { recursive: true, mode: 0o700 })
  const logFile = path.join(logDirectory, `${preview.id}.log`)
  const fd = fs.openSync(
    logFile,
    fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
    0o600,
  )
  let launched = false
  try {
    signal.throwIfAborted()
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', fd, fd],
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    child.unref()
    const pid = child.pid!
    const info = inspectProcess(pid)
    if (!info || info.group !== pid || !isInside(preview.cwd, info.cwd)) {
      try {
        process.kill(-pid, 'SIGTERM')
      } catch {}
      throw new Error('El proceso no conserva el aislamiento del preview.')
    }
    previews.store.db
      .prepare('UPDATE previews SET pid=?,process_start=? WHERE id=?')
      .run(pid, info.start, preview.id)
    launched = true
    const deadline = Date.now() + 60000
    let lastError = ''
    while (Date.now() < deadline) {
      signal.throwIfAborted()
      const current = previews.get(key)
      if (!current || !previews.ownsProcess(current))
        throw new Error('La app termino durante el arranque.')
      try {
        return { ...(await previews.publish(key, pid)), pid, log_file: logFile }
      } catch (error) {
        lastError = (error as Error).message
      }
      await delay(250, undefined, { signal })
    }
    throw new Error(`La app no estuvo lista en 60 segundos: ${lastError}`)
  } catch (error) {
    if (launched) previews.stop(key)
    throw new Error(`${(error as Error).message} Log de arranque: ${logFile}`)
  } finally {
    fs.closeSync(fd)
  }
}
