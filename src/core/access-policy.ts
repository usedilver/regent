import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Config } from '../config.ts'

export const AccessSchema = z
  .object({
    slack: z.object({ allowed_users: z.array(z.string().min(1)).max(10000) }).strict(),
    oauth: z
      .object({
        allowed_emails: z
          .array(
            z
              .string()
              .email()
              .transform((value) => value.toLowerCase()),
          )
          .min(1)
          .max(1000),
      })
      .strict()
      .optional(),
  })
  .strict()
export type AccessDocument = z.infer<typeof AccessSchema>
export type AccessSnapshot = Readonly<{
  slack: Readonly<{ allowed_users: readonly string[] }>
  oauth?: Readonly<{ allowed_emails: readonly string[] }>
}>

export function legacyAccess(config: Config): AccessDocument {
  return {
    slack: { allowed_users: config.slack.allowed_users },
    ...(config.mcp.oauth
      ? { oauth: { allowed_emails: config.mcp.oauth.oidc.allowed_emails ?? [] } }
      : {}),
  }
}

export class AccessPolicy {
  private current!: AccessSnapshot
  private digest = ''
  constructor(document: AccessDocument) {
    this.replace(document)
  }
  get snapshot(): AccessSnapshot {
    return this.current
  }
  get version(): string {
    return this.digest.slice(0, 12)
  }
  get openSlack(): boolean {
    return this.current.slack.allowed_users.length === 0
  }
  allowsSlack(author: string): boolean {
    return this.openSlack || this.current.slack.allowed_users.includes(author)
  }
  allowsOAuth(email: string): boolean {
    return this.current.oauth?.allowed_emails.includes(email.toLowerCase()) ?? false
  }
  replace(document: AccessDocument): boolean {
    const parsed = AccessSchema.parse(document)
    const snapshot = Object.freeze({
      slack: Object.freeze({
        allowed_users: Object.freeze([...new Set(parsed.slack.allowed_users)].sort()),
      }),
      ...(parsed.oauth
        ? {
            oauth: Object.freeze({
              allowed_emails: Object.freeze([...new Set(parsed.oauth.allowed_emails)].sort()),
            }),
          }
        : {}),
    })
    const digest = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
    if (digest === this.digest) return false
    this.current = snapshot
    this.digest = digest
    return true
  }
}
