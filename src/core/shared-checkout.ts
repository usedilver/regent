import { execFile } from 'node:child_process'

const STATUS_TIMEOUT_MS = 15000
const REPORTED_ENTRIES = 20
/** Where conversations keep their own worktrees and the CLI its local state. */
const OWN_PLACES = ['.worktrees/', '.claude/']

/**
 * The project's shared checkout entries Git reports as changed or untracked, including dirty
 * submodules. Undefined when Git cannot tell, so a failed read never raises an alert.
 */
export function sharedCheckoutEntries(project: string): Promise<Set<string> | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      // Read only: a status that refreshed the index would hold its lock against other Git work.
      ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=normal'],
      { cwd: project, timeout: STATUS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve(undefined)
        const entries = new Set<string>()
        const fields = stdout.split('\0')

        for (let i = 0; i < fields.length; i++) {
          const entry = fields[i]
          if (!entry) continue
          // A rename or copy carries its source path in the next field.
          if (/^[RC]/.test(entry)) i++
          const file = entry.slice(3)
          if (!OWN_PLACES.some((place) => file.startsWith(place))) entries.add(entry)
        }

        resolve(entries)
      },
    )
  })
}

/** Entries present after a run that were not there before it, at most REPORTED_ENTRIES of them. */
export function newEntries(before: Set<string>, after: Set<string>): string[] {
  return [...after].filter((entry) => !before.has(entry)).slice(0, REPORTED_ENTRIES)
}
