/** Carga .env del directorio del bridge (sin dependencias; mismo formato que siempre). */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const BRIDGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * KEY=VALUE de un .env, sin expansión de shell: un `$` en una contraseña llega
 * literal. Comillas envolventes se quitan; comentarios y líneas vacías se ignoran.
 */
export function parseEnvFile(envPath: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!fs.existsSync(envPath)) return out
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2')
  }
  return out
}

export function loadEnv(): void {
  for (const [key, val] of Object.entries(parseEnvFile(path.join(BRIDGE_DIR, '.env')))) {
    if (!(key in process.env)) process.env[key] = val
  }
}

/** Lista de .env a inyectar: la configurada, o el .env de la raíz dada (como `talently claude`). */
export function agentEnvFiles(configured: string[], fallbackRoot?: string): string[] {
  if (configured.length) return configured
  return fallbackRoot ? [path.join(fallbackRoot, '.env')] : []
}

/** Vars de esos archivos, en orden (el último gana); `~` permitido. Los que no existen cuentan 0. */
export function loadAgentEnv(files: string[]): { vars: Record<string, string>; files: Array<{ file: string; count: number }> } {
  const vars: Record<string, string> = {}
  const report: Array<{ file: string; count: number }> = []
  for (const f of files) {
    const resolved = f.replace(/^~(?=$|\/)/, process.env.HOME ?? '')
    const parsed = parseEnvFile(resolved)
    Object.assign(vars, parsed)
    report.push({ file: resolved, count: Object.keys(parsed).length })
  }
  return { vars, files: report }
}
