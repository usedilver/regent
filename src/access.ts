import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import YAML from 'yaml'
import type { Config } from './config.ts'
import { REGENT_DIR } from './env.ts'
import {
  AccessPolicy,
  AccessSchema,
  legacyAccess,
  type AccessDocument,
} from './core/access-policy.ts'

const POLL_MS = 2000
const MAX_BYTES = 128 * 1024
const hash = (content: string) => createHash('sha256').update(content).digest('hex')
class PolicyError extends Error {
  constructor(category: string, fields: string[] = []) {
    super(`Access policy rejected (${category})${fields.length ? ': ' + fields.join(', ') : ''}.`)
  }
}
function read(file: string): string {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) throw new PolicyError('read')
    if (stat.size > MAX_BYTES) throw new PolicyError('size')
    const content = fs.readFileSync(file, 'utf8')
    if (Buffer.byteLength(content) > MAX_BYTES) throw new PolicyError('size')
    return content
  } catch (error) {
    if (error instanceof PolicyError) throw error
    throw new PolicyError('read')
  }
}
function parse(content: string, oauthRequired: boolean): AccessDocument {
  let raw: unknown
  try {
    raw = YAML.parse(content, { logLevel: 'silent' })
  } catch {
    throw new PolicyError('yaml')
  }
  const result = AccessSchema.safeParse(raw)
  if (!result.success)
    throw new PolicyError('schema', [
      ...new Set(result.error.issues.map((issue) => issue.path.join('.') || 'document')),
    ])
  if (oauthRequired && !result.data.oauth) throw new PolicyError('schema', ['oauth.allowed_emails'])
  return result.data
}

export function loadAccess(config: Config): {
  policy: AccessPolicy
  file?: string
  contentHash?: string
} {
  if (!config.access_policy_file) return { policy: new AccessPolicy(legacyAccess(config)) }
  const file = path.resolve(
    REGENT_DIR,
    config.access_policy_file.replace(/^~(?=$|\/)/, process.env.HOME ?? ''),
  )
  const content = read(file)
  return {
    policy: new AccessPolicy(parse(content, Boolean(config.mcp.oauth))),
    file,
    contentHash: hash(content),
  }
}

export class AccessReloader {
  private timer?: ReturnType<typeof setInterval>
  private stopped = false
  private lastHash?: string
  private diagnostic?: string
  readonly policy: AccessPolicy
  readonly file: string
  private options: {
    oauthRequired: boolean
    contentHash?: string
    intervalMs?: number
    changed?: (previous: AccessPolicy['snapshot']) => void
    report?: (message: string) => void
  }
  constructor(policy: AccessPolicy, file: string, options: AccessReloader['options']) {
    this.policy = policy
    this.file = file
    this.options = options
    this.lastHash = options.contentHash
  }
  private report(message: string) {
    const report = this.options.report ?? console.info
    report(message)
  }
  reload(): boolean {
    if (this.stopped) return false
    let content: string
    try {
      content = read(this.file)
    } catch (error) {
      this.lastHash = undefined
      this.reject(error)
      return false
    }
    const digest = hash(content)
    if (digest === this.lastHash) return false
    this.lastHash = digest
    let document: AccessDocument
    try {
      document = parse(content, this.options.oauthRequired)
    } catch (error) {
      this.reject(error)
      return false
    }
    const recovered = Boolean(this.diagnostic)
    this.diagnostic = undefined
    const previous = this.policy.snapshot
    const changed = this.policy.replace(document)
    if (changed) {
      const snapshot = this.policy.snapshot
      this.report(
        `Access policy ${this.policy.version} applied: Slack=${snapshot.slack.allowed_users.length}${this.policy.openSlack ? ' (verified workspace membership; empty list broadens access)' : ''}, OAuth=${snapshot.oauth?.allowed_emails.length ?? 0}.`,
      )
      this.options.changed?.(previous)
    } else if (recovered) this.report('Access policy valid again; effective permissions unchanged.')
    return changed
  }
  private reject(error: unknown): void {
    const message =
      (error instanceof PolicyError ? error.message : 'Access policy rejected (read).') +
      ' Previous valid policy retained.'
    if (message !== this.diagnostic) this.report(message)
    this.diagnostic = message
  }
  start(): void {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => {
      try {
        this.reload()
      } catch {
        this.report('Access policy applied; a change callback failed.')
      }
    }, this.options.intervalMs ?? POLL_MS)
    this.timer.unref()
  }
  close(): void {
    this.stopped = true
    clearInterval(this.timer)
    this.timer = undefined
  }
}
