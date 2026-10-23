import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export type ProcessInfo = { cwd: string; start: string; group: number }

export function inspectProcess(pid: number): ProcessInfo | null {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      return { cwd: fs.realpathSync(`/proc/${pid}/cwd`), start: fields[19], group: Number(fields[2]) }
    }
    const cwd = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').find(line => line.startsWith('n'))?.slice(1)
    const start = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim()
    const group = Number(execFileSync('ps', ['-p', String(pid), '-o', 'pgid='], { encoding: 'utf8' }).trim())
    return cwd && start ? { cwd: fs.realpathSync(cwd), start, group } : null
  } catch { return null }
}

const inside = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export function ownsListener(port: number, group: number, directory: string): boolean {
  try {
    if (process.platform === 'linux') {
      const listeners = new Set<string>()
      for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
        if (!fs.existsSync(table)) continue
        for (const line of fs.readFileSync(table, 'utf8').trim().split('\n').slice(1)) {
          const fields = line.trim().split(/\s+/)
          if (fields[3] === '0A' && Number.parseInt(fields[1].split(':')[1], 16) === port) listeners.add(fields[9])
        }
      }
      if (!listeners.size) return false
      const owned = new Set<string>()
      for (const entry of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue
        const info = inspectProcess(Number(entry))
        if (!info || info.group !== group || !inside(directory, info.cwd)) continue
        try {
          for (const fd of fs.readdirSync(`/proc/${entry}/fd`)) {
            try {
              const socket = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${entry}/fd/${fd}`))
              if (socket) owned.add(socket[1])
            } catch { /* A process can close a descriptor while it is inspected. */ }
          }
        } catch { /* A process can exit while its group is inspected. */ }
      }
      return [...listeners].every(inode => owned.has(inode))
    }
    const output = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    const owners = [...new Set(output.split('\n').filter(line => /^p\d+$/.test(line)).map(line => Number(line.slice(1))))]
    return owners.length > 0 && owners.every(pid => {
      const info = inspectProcess(pid)
      return Boolean(info && info.group === group && inside(directory, info.cwd))
    })
  } catch { return false }
}
