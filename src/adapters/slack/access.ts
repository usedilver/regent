import type { AccessPolicy } from '../../core/access-policy.ts'

type Member = {
  is_bot?: boolean
  deleted?: boolean
  is_stranger?: boolean
  team_id?: string
}

export class SlackAccess {
  private membership = new Map<string, { allowed: boolean; checkedAt: number }>()
  private policy: AccessPolicy
  private team: string
  private lookup: (author: string) => Promise<Member | undefined>
  private now: () => number
  constructor(
    policy: AccessPolicy,
    team: string,
    lookup: (author: string) => Promise<Member | undefined>,
    now: () => number = Date.now,
  ) {
    this.policy = policy
    this.team = team
    this.lookup = lookup
    this.now = now
  }

  async allowed(author: string): Promise<boolean> {
    if (!this.policy.allowsSlack(author)) return false
    if (!this.policy.openSlack) return true
    let entry = this.membership.get(author)

    if (!entry || this.now() - entry.checkedAt > 300000) {
      const user = await this.lookup(author)
      entry = {
        allowed: Boolean(
          user && !user.is_bot && !user.deleted && !user.is_stranger && user.team_id === this.team,
        ),
        checkedAt: this.now(),
      }
      this.membership.set(author, entry)
    }

    return this.policy.allowsSlack(author) && (!this.policy.openSlack || entry.allowed)
  }
}
