/**
 * Limpieza post-merge: cuando el PR de un card se mergea, su worktree y su rama
 * ya cumplieron. Best-effort y conservador: un worktree con cambios sin commitear
 * NO se borra (se loguea y un humano decide).
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { BRIDGE_DIR } from './env.ts'

const sh = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) as string

export interface CleanupResult {
  worktree?: string
  branch?: string
  skipped?: string
}

/** Limpia el worktree `worktrees/*-<shortId>` y la rama `agent/<shortId>` del repo dueño. */
export function cleanupCardWorktree(pageId: string): CleanupResult {
  const shortId = pageId.replace(/-/g, '').slice(-12)
  const wtRoot = path.join(BRIDGE_DIR, 'worktrees')
  if (!fs.existsSync(wtRoot)) return {}
  const dirName = fs.readdirSync(wtRoot).find(d => d.endsWith(`-${shortId}`))
  if (!dirName) return {}
  const wtDir = path.join(wtRoot, dirName)

  // repo dueño: el git-common-dir del worktree apunta al .git del repo principal
  let mainRepo: string
  try {
    const common = sh('git', ['-C', wtDir, 'rev-parse', '--git-common-dir']).trim()
    mainRepo = path.dirname(path.isAbsolute(common) ? common : path.resolve(wtDir, common))
  } catch {
    return { skipped: `${dirName}: no pude resolver el repo dueño` }
  }

  // ¿cambios sin commitear? → no tocar
  try {
    if (sh('git', ['-C', wtDir, 'status', '--porcelain']).trim() !== '') {
      return { skipped: `${dirName}: tiene cambios sin commitear — limpiar a mano` }
    }
  } catch { /* si status falla, seguimos con el remove sin --force que protege igual */ }

  const result: CleanupResult = {}
  try {
    sh('git', ['-C', mainRepo, 'worktree', 'remove', wtDir])
    result.worktree = dirName
  } catch (err) {
    return { skipped: `${dirName}: worktree remove falló (${(err as Error).message.split('\n')[0]})` }
  }
  try {
    // -D deliberado: el merge ocurrió en origin; la rama local no figura como mergeada
    sh('git', ['-C', mainRepo, 'branch', '-D', `agent/${shortId}`])
    result.branch = `agent/${shortId}`
  } catch { /* rama ya borrada */ }
  return result
}
