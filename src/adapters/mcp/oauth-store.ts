import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  InvalidGrantError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { Store } from '../../storage/store.ts'

export const MCP_SCOPE = 'regent:execute'
export const ACCESS_SECONDS = 900

const SESSION_SECONDS = 7 * 24 * 60 * 60
const hash = (token: string) => createHash('sha256').update(token).digest('hex')
const now = () => Math.floor(Date.now() / 1000)

export interface OAuthIdentity {
  issuer: string
  sub: string
  email: string
  name: string
}
interface Session {
  id: string
  author: string
  identity: string
  client_id: string
  resource: string
  expires_at: number
  revoked: number
}
interface TokenSession extends Session {
  kind: string
  token_expires_at: number
  used: number
}

export class OAuthStore {
  readonly store: Store
  readonly allowed: (identity: OAuthIdentity) => boolean
  constructor(store: Store, allowed: (identity: OAuthIdentity) => boolean) {
    this.store = store
    this.allowed = allowed
  }

  getClient(id: string): OAuthClientInformationFull | undefined {
    const row = this.store.db.prepare('SELECT metadata FROM oauth_clients WHERE id=?').get(id)
    return row ? JSON.parse(row.metadata as string) : undefined
  }

  saveClient(client: OAuthClientInformationFull): void {
    this.store.db
      .prepare('INSERT INTO oauth_clients VALUES(?,?)')
      .run(client.client_id, JSON.stringify(client))
  }

  author(identity: OAuthIdentity): string {
    return `mcp:oauth-${hash(JSON.stringify([identity.issuer, identity.sub]))}`
  }

  identity(author: string): OAuthIdentity | undefined {
    const rows = this.store.db
      .prepare('SELECT identity FROM oauth_sessions WHERE author=? AND revoked=0 AND expires_at>?')
      .all(author, now())

    for (const row of rows) {
      const identity = JSON.parse(row.identity as string) as OAuthIdentity
      if (this.allowed(identity)) return identity
    }
  }

  issue(clientId: string, identity: OAuthIdentity, resource: string): OAuthTokens {
    if (!this.allowed(identity)) throw new InvalidGrantError('Acceso no autorizado.')
    return this.store.transaction(() => {
      const session: Session = {
        id: randomUUID(),
        author: this.author(identity),
        identity: JSON.stringify(identity),
        client_id: clientId,
        resource,
        expires_at: now() + SESSION_SECONDS,
        revoked: 0,
      }

      this.store.db
        .prepare(
          'INSERT INTO oauth_sessions(id,author,identity,client_id,resource,expires_at) VALUES(?,?,?,?,?,?)',
        )
        .run(
          session.id,
          session.author,
          session.identity,
          session.client_id,
          session.resource,
          session.expires_at,
        )
      return this.tokens(session)
    })
  }

  private tokens(session: Session): OAuthTokens {
    this.store.db
      .prepare(
        "DELETE FROM oauth_tokens WHERE (kind='access' AND expires_at<=?) OR session_id IN (SELECT id FROM oauth_sessions WHERE expires_at<=?)",
      )
      .run(now(), now())
    this.store.db.prepare('DELETE FROM oauth_sessions WHERE expires_at<=?').run(now())
    const access = randomBytes(32).toString('base64url')
    const refresh = randomBytes(32).toString('base64url')
    const expires = Math.min(now() + ACCESS_SECONDS, session.expires_at)
    const insert = this.store.db.prepare(
      'INSERT INTO oauth_tokens(hash,kind,session_id,expires_at) VALUES(?,?,?,?)',
    )

    insert.run(hash(access), 'access', session.id, expires)
    insert.run(hash(refresh), 'refresh', session.id, session.expires_at)
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: expires - now(),
      refresh_token: refresh,
      scope: MCP_SCOPE,
    }
  }

  private lookup(token: string): TokenSession | undefined {
    return this.store.db
      .prepare(
        `SELECT s.*,t.kind,t.expires_at AS token_expires_at,t.used FROM oauth_tokens t
      JOIN oauth_sessions s ON s.id=t.session_id WHERE t.hash=?`,
      )
      .get(hash(token)) as unknown as TokenSession | undefined
  }

  private valid(session: TokenSession | undefined): session is TokenSession {
    return Boolean(
      session &&
        !session.revoked &&
        session.expires_at > now() &&
        session.token_expires_at > now() &&
        this.allowed(JSON.parse(session.identity)),
    )
  }

  verify(token: string, resource: string) {
    const session = this.lookup(token)

    if (!this.valid(session) || session.kind !== 'access' || session.resource !== resource) {
      throw new InvalidTokenError('Token invalido, vencido o revocado.')
    }

    return {
      token,
      clientId: session.client_id,
      scopes: [MCP_SCOPE],
      expiresAt: session.token_expires_at,
      resource: new URL(resource),
      extra: { author: session.author },
    }
  }

  refresh(clientId: string, token: string, resource: string): OAuthTokens {
    const result = this.store.transaction(() => {
      const session = this.lookup(token)

      if (
        !this.valid(session) ||
        session.kind !== 'refresh' ||
        session.client_id !== clientId ||
        session.resource !== resource
      ) {
        throw new InvalidGrantError('Refresh token invalido.')
      }

      if (session.used) {
        this.store.db.prepare('UPDATE oauth_sessions SET revoked=1 WHERE id=?').run(session.id)
        return null
      }

      this.store.db.prepare('UPDATE oauth_tokens SET used=1 WHERE hash=?').run(hash(token))
      return this.tokens(session)
    })

    if (!result) throw new InvalidGrantError('Refresh token reutilizado; conexion revocada.')
    return result
  }

  revoke(clientId: string, token: string): void {
    const session = this.lookup(token)

    if (session?.client_id === clientId) {
      this.store.db.prepare('UPDATE oauth_sessions SET revoked=1 WHERE id=?').run(session.id)
    }
  }
}
