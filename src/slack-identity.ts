import type { Identity, IdentityResolver } from './identity.ts'

const field = (value: unknown) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 254) || undefined : undefined

export function createIdentityResolver(api: (method: string, args: Record<string, unknown>) => Promise<any>, team: string, now = Date.now): IdentityResolver {
  const cache = new Map<string, { identity: Identity; expires: number }>()
  return async (id, signal) => {
    signal?.throwIfAborted()
    const hit = cache.get(id)
    if (hit && hit.expires > now()) return hit.identity
    let identity: Identity = {}
    let ttl = 30000
    try {
      const { user } = await api('users.info', { user: id })
      signal?.throwIfAborted()
      if (user?.id === id && !user.deleted && !user.is_bot && !user.is_app_user && !user.is_stranger &&
          (user.team_id === team || user.enterprise_user?.teams?.includes(team))) {
        const name = field(user.profile?.real_name) ?? field(user.real_name) ?? field(user.profile?.display_name)
        const email = field(user.profile?.email)
        identity = { ...(name ? { name } : {}), ...(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { email } : {}) }
        ttl = 300000
      }
    } catch { signal?.throwIfAborted() }
    if (cache.size >= 1000) cache.delete(cache.keys().next().value!)
    cache.set(id, { identity, expires: now() + ttl })
    return identity
  }
}
