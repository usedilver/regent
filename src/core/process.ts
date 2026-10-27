import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

export type ProcessInfo = { cwd: string; start: string; group: number }

function linuxProcess(pid: number): ProcessInfo {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
  // Fields after the parenthesized command name; starttime is the 22nd field overall.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  return { cwd: fs.realpathSync(`/proc/${pid}/cwd`), start: fields[19], group: Number(fields[2]) }
}

function psProcess(pid: number): ProcessInfo | null {
  const ps = (column: string) =>
    execFileSync('ps', ['-p', String(pid), '-o', column], { encoding: 'utf8' }).trim()
  const cwd = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .split('\n')
    .find((line) => line.startsWith('n'))
    ?.slice(1)
  const start = ps('lstart=')
  const group = Number(ps('pgid='))
  return cwd && start ? { cwd: fs.realpathSync(cwd), start, group } : null
}

/** Working directory, start time and process group of a live process, or null if it is gone. */
export function inspectProcess(pid: number): ProcessInfo | null {
  try {
    return process.platform === 'linux' ? linuxProcess(pid) : psProcess(pid)
  } catch {
    return null
  }
}
