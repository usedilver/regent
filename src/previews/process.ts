import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { isInside } from '../core/repository.ts'

export type ProcessInfo = { cwd: string; start: string; group: number }

const LISTENING = '0A'

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

function belongsTo(pid: number, group: number, directory: string): boolean {
  const info = inspectProcess(pid)
  return Boolean(info && info.group === group && isInside(directory, info.cwd))
}

/** Socket inodes listening on the port, from /proc/net/tcp and tcp6. */
function linuxListeningInodes(port: number): Set<string> {
  const inodes = new Set<string>()

  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    if (!fs.existsSync(table)) continue

    for (const line of fs.readFileSync(table, 'utf8').trim().split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/)
      const localPort = Number.parseInt(fields[1].split(':')[1], 16)
      if (fields[3] === LISTENING && localPort === port) inodes.add(fields[9])
    }
  }

  return inodes
}

/** The socket inodes a process holds open. It can exit, or close a descriptor, mid-scan. */
function socketInodes(pid: string): string[] {
  const inodes: string[] = []
  let descriptors: string[]

  try {
    descriptors = fs.readdirSync(`/proc/${pid}/fd`)
  } catch {
    return inodes
  }

  for (const fd of descriptors) {
    try {
      const socket = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`))
      if (socket) inodes.push(socket[1])
    } catch {
      /* Closed while it was inspected. */
    }
  }

  return inodes
}

function linuxOwnsListener(port: number, group: number, directory: string): boolean {
  const listeners = linuxListeningInodes(port)
  if (!listeners.size) return false
  const owned = new Set<string>()

  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || !belongsTo(Number(entry), group, directory)) continue
    for (const inode of socketInodes(entry)) owned.add(inode)
  }

  return [...listeners].every((inode) => owned.has(inode))
}

function lsofOwnsListener(port: number, group: number, directory: string): boolean {
  const output = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const owners = [
    ...new Set(
      output
        .split('\n')
        .filter((line) => /^p\d+$/.test(line))
        .map((line) => Number(line.slice(1))),
    ),
  ]

  return owners.length > 0 && owners.every((pid) => belongsTo(pid, group, directory))
}

/** True when every listener on the port belongs to the process group running in the directory. */
export function ownsListener(port: number, group: number, directory: string): boolean {
  try {
    if (process.platform === 'linux') return linuxOwnsListener(port, group, directory)
    return lsofOwnsListener(port, group, directory)
  } catch {
    return false
  }
}
