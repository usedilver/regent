import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import type { Config } from './config.ts'
import { REGENT_DIR } from './env.ts'
import {
  AccessPolicy,
  AccessSchema,
  legacyAccess,
  type AccessDocument,
} from './core/access-policy.ts'

const MAX_BYTES = 128 * 1024

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
    const document = YAML.parseDocument(content, { logLevel: 'silent' })
    if (document.errors.length || document.warnings.length) throw new PolicyError('yaml')
    raw = document.toJS()
  } catch {
    throw new PolicyError('yaml')
  }

  const result = AccessSchema.safeParse(raw)

  if (!result.success) {
    throw new PolicyError('schema', [
      ...new Set(result.error.issues.map((issue) => issue.path.join('.') || 'document')),
    ])
  }

  if (oauthRequired && !result.data.oauth) throw new PolicyError('schema', ['oauth.allowed_emails'])
  return result.data
}

export function loadAccess(config: Config): {
  policy: AccessPolicy
  file?: string
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
  }
}

export class AccessReloader {
  readonly policy: AccessPolicy
  readonly file: string
  private options: {
    oauthRequired: boolean
    changed?: (previous: AccessPolicy['snapshot']) => void
    report?: (message: string) => void
  }

  constructor(policy: AccessPolicy, file: string, options: AccessReloader['options']) {
    this.policy = policy
    this.file = file
    this.options = options
  }

  private report(message: string) {
    const report = this.options.report ?? console.info
    report(message)
  }

  reload(): boolean {
    let document: AccessDocument

    try {
      document = parse(read(this.file), this.options.oauthRequired)
    } catch (error) {
      const message =
        error instanceof PolicyError ? error.message : 'Access policy rejected (read).'

      this.report(message + ' Previous valid policy retained.')
      return false
    }

    const previous = this.policy.snapshot
    const changed = this.policy.replace(document)

    if (changed) {
      const snapshot = this.policy.snapshot
      this.report(
        `Access policy ${this.policy.version} applied: Slack=${snapshot.slack.allowed_users.length}${this.policy.openSlack ? ' (verified workspace membership; empty list broadens access)' : ''}, OAuth=${snapshot.oauth?.allowed_emails.length ?? 0}.`,
      )
      this.options.changed?.(previous)
    } else {
      this.report(`Access policy ${this.policy.version} valid; effective permissions unchanged.`)
    }

    return changed
  }
}
