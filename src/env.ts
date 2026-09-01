/** Carga .env del directorio del bridge (sin dependencias; mismo formato que siempre). */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const BRIDGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

export function loadEnv(): void {
  const envPath = path.join(BRIDGE_DIR, '.env')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m) continue
    const val = m[2].replace(/^["']|["']$/g, '')
    if (!(m[1] in process.env)) process.env[m[1]] = val
  }
}
