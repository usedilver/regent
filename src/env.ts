import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REGENT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** A leading `~` as the user's home directory; everything else untouched. */
export function expandHome(value: string): string {
  return value.replace(/^~(?=$|\/)/, process.env.HOME ?? '')
}

/**
 * KEY=VALUE pairs from a .env file, with no shell expansion: a `$` inside a password
 * arrives literally. Surrounding quotes are stripped; comments and blank lines are ignored.
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

/** Keys defined in regent's own .env (its Slack/Notion/GitHub secrets): never handed to the agent. */
export function ownEnvKeys(file: string = path.join(REGENT_DIR, '.env')): string[] {
  return Object.keys(parseEnvFile(file))
}

export function loadEnv(): void {
  for (const [key, val] of Object.entries(parseEnvFile(path.join(REGENT_DIR, '.env')))) {
    if (!(key in process.env)) process.env[key] = val
  }
}

/** The .env files to inject: the configured list, or the project root's .env. */
export function agentEnvFiles(configured: string[], fallbackRoot?: string): string[] {
  if (configured.length) return configured
  return fallbackRoot ? [path.join(fallbackRoot, '.env')] : []
}

/** Variables from those files in order (the last one wins); `~` is allowed. Missing files count 0. */
export function loadAgentEnv(files: string[]): {
  vars: Record<string, string>
  files: Array<{ file: string; count: number }>
} {
  const vars: Record<string, string> = {}
  const report: Array<{ file: string; count: number }> = []

  for (const f of files) {
    const resolved = expandHome(f)
    const parsed = parseEnvFile(resolved)
    Object.assign(vars, parsed)
    report.push({ file: resolved, count: Object.keys(parsed).length })
  }

  return { vars, files: report }
}
