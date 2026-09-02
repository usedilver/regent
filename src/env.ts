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
