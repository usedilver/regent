import type { Identity, IdentityResolver } from '../../core/identity.ts'
import type { SlackApi } from './api.ts'

const CACHE_LIMIT = 1000
/** Unknown or foreign users are retried soon; known members are remembered longer. */
const MISS_TTL_MS = 30000
const HIT_TTL_MS = 300000
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const field = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  return (
    value
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim()
      .slice(0, 254) || undefined
  )
}

/** A real, active human member of this workspace (or of its enterprise grid). */
function memberOf(user: any, id: string, team: string): boolean {
  return (
    user?.id === id &&
    !user.deleted &&
    !user.is_bot &&
    !user.is_app_user &&
    !user.is_stranger &&
    (user.team_id === team || user.enterprise_user?.teams?.includes(team))
  )
}

function identityOf(user: any): Identity {
  const name =
    field(user.profile?.real_name) ?? field(user.real_name) ?? field(user.profile?.display_name)
  const email = field(user.profile?.email)

  return {
    ...(name ? { name } : {}),
    ...(email && EMAIL.test(email) ? { email } : {}),
  }
}

export function createIdentityResolver(
  api: SlackApi,
  team: string,
  now = Date.now,
): IdentityResolver {
  const cache = new Map<string, { identity: Identity; expires: number }>()

  const remember = (id: string, identity: Identity, ttl: number) => {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!)
    cache.set(id, { identity, expires: now() + ttl })
  }

  return async (id, signal) => {
    signal?.throwIfAborted()
    const hit = cache.get(id)
    if (hit && hit.expires > now()) return hit.identity
    let identity: Identity = {}
    let ttl = MISS_TTL_MS

    try {
      const { user } = await api('users.info', { user: id })
      signal?.throwIfAborted()

      if (memberOf(user, id, team)) {
        identity = identityOf(user)
        ttl = HIT_TTL_MS
      }
    } catch {
      signal?.throwIfAborted()
    }

    remember(id, identity, ttl)
    return identity
  }
}
