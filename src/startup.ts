import { execFileSync } from 'node:child_process'
import { assertIsolationVersion } from './execution/runner.ts'

export function claudeVersion(): string {
  const version = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 10000 }).trim()
  assertIsolationVersion(version)
  const help = execFileSync('claude', ['--help'], { encoding: 'utf8', timeout: 10000 })

  for (const flag of [
    '--permission-prompts',
    '--plugin-dir',
    '--include-partial-messages',
    '--worktree',
    '--input-format',
  ]) {
    if (!help.includes(flag)) throw new Error(`Actualiza Claude Code: falta ${flag}.`)
  }

  return version
}
