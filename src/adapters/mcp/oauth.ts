import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import express from 'express'
import * as oidc from 'openid-client'
import { createOAuthMetadata, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js'
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js'
import {
  AccessDeniedError,
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTokenError,
  TooManyRequestsError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Config } from '../../config.ts'
import type { Store } from '../../storage/store.ts'
import { MCP_SCOPE, OAuthStore, type OAuthIdentity } from './oauth-store.ts'

type Settings = NonNullable<Config['mcp']['oauth']>
interface Login {
  client: OAuthClientInformationFull
  params: AuthorizationParams
  expires: number
  cookie: string
  csrf: string
  verifier: string
  nonce: string
  phase: 'login' | 'verifying' | 'consent'
  identity?: OAuthIdentity
}
interface Code {
  clientId: string
  params: AuthorizationParams
  identity: OAuthIdentity
  expires: number
}
const LOGIN_MS = 10 * 60 * 1000
const CODE_MS = 60 * 1000
const MAX_PENDING = 1000
const random = () => randomBytes(32).toString('base64url')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const equal = (left: string, right: string) =>
  timingSafeEqual(Buffer.from(hash(left)), Buffer.from(hash(right)))
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  )

export class OAuthServer implements OAuthServerProvider {
  readonly settings: Settings
  readonly name: string
  readonly app = express()
  readonly tokens: OAuthStore
  readonly resource: string
  readonly issuer: URL
  private logins = new Map<string, Login>()
  private codes = new Map<string, Code>()
  private provider?: Promise<oidc.Configuration>
  private secret: string
  constructor(settings: Settings, name: string, store: Store, env: NodeJS.ProcessEnv) {
    this.settings = settings
    this.name = name
    this.issuer = new URL(settings.issuer_url)
    this.resource = new URL('/mcp', this.issuer).href
    this.secret = env[settings.oidc.client_secret_env]?.trim() ?? ''
    if (!this.secret)
      throw new Error(`Configura ${settings.oidc.client_secret_env} para el login MCP.`)
    this.tokens = new OAuthStore(store, (identity) => this.allowed(identity))
    const callbackOrigins = [
      ...new Set(settings.redirect_uris.map((uri) => new URL(uri).origin)),
    ].join(' ')
    this.app.disable('x-powered-by')
    if (settings.trust_proxy === 'loopback') this.app.set('trust proxy', 'loopback')
    this.app.use((_req, res, next) => {
      res.set({
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${callbackOrigins}; frame-ancestors 'none'; base-uri 'none'`,
      })
      next()
    })
    const options = {
      provider: this,
      issuerUrl: this.issuer,
      resourceServerUrl: new URL(this.resource),
      scopesSupported: [MCP_SCOPE],
      resourceName: name,
    }
    this.app.use(
      '/.well-known/oauth-authorization-server',
      metadataHandler({
        ...createOAuthMetadata(options),
        token_endpoint_auth_methods_supported: ['none'],
        revocation_endpoint_auth_methods_supported: ['none'],
      }),
    )
    this.app.use(mcpAuthRouter(options))
    this.app.get('/oauth/callback', (req, res) => {
      void this.callback(req, res)
    })
    this.app.get('/oauth/consent', (req, res) => {
      const id = typeof req.query.request === 'string' ? req.query.request : ''
      const login = this.login(req, id)
      if (!login || login.phase !== 'consent' || !login.identity)
        return this.failure(res, 'La solicitud vencio. Vuelve a conectar desde tu cliente.')
      this.page(
        res,
        'Conectar con ' + name,
        `<p>Has iniciado sesion como <strong>${escape(login.identity.email)}</strong>.</p>
        <p><strong>${escape(login.client.client_name ?? 'Tu cliente MCP')}</strong> solicita usar ${escape(name)} para consultar proyectos y crear, modificar o eliminar codigo con los accesos configurados del servidor.</p>
        <form method="post" action="/oauth/consent"><input type="hidden" name="request" value="${escape(id)}"><input type="hidden" name="csrf" value="${escape(login.csrf)}">
        <button name="decision" value="allow">Conectar</button><button class="secondary" name="decision" value="deny">Cancelar</button></form>`,
      )
    })
    this.app.post(
      '/oauth/consent',
      express.urlencoded({ extended: false, limit: '8kb' }),
      (req, res) => this.consent(req, res),
    )
    this.app.use(
      (
        _error: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => this.failure(res, 'No se pudo completar la conexion.'),
    )
  }
  handles(request: IncomingMessage, response: ServerResponse): boolean {
    const pathname = new URL(request.url ?? '/', this.issuer).pathname
    if (
      ![
        '/.well-known/oauth-authorization-server',
        '/.well-known/oauth-protected-resource/mcp',
        '/authorize',
        '/token',
        '/register',
        '/revoke',
        '/oauth/callback',
        '/oauth/consent',
      ].includes(pathname)
    )
      return false
    this.app(request, response)
    return true
  }
  challenge(): string {
    return `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource/mcp', this.issuer).href}", scope="${MCP_SCOPE}"`
  }
  private allowed(identity: OAuthIdentity): boolean {
    return (
      new URL(identity.issuer).href === new URL(this.settings.oidc.issuer_url).href &&
      this.settings.oidc.allowed_emails.includes(identity.email)
    )
  }
  get clientsStore() {
    return {
      getClient: (id: string) => {
        const client = this.tokens.getClient(id)
        return client?.redirect_uris.every((uri) => this.callbackAllowed(uri)) ? client : undefined
      },
      registerClient: async (
        metadata: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
      ) => {
        if (
          (this.tokens.store.db.prepare('SELECT count(*) AS n FROM oauth_clients').get()!
            .n as number) >= MAX_PENDING
        )
          throw new TooManyRequestsError('Limite de clientes registrados alcanzado.')
        if (metadata.token_endpoint_auth_method && metadata.token_endpoint_auth_method !== 'none')
          throw new InvalidClientMetadataError('Usa un cliente publico con PKCE.')
        if (
          !metadata.redirect_uris.length ||
          metadata.redirect_uris.some((uri) => !this.callbackAllowed(uri))
        )
          throw new InvalidClientMetadataError('Callback no autorizado para esta instancia.')
        this.scopes(metadata.scope?.split(' '))
        const client: OAuthClientInformationFull = {
          client_id: randomUUID(),
          client_id_issued_at: Math.floor(Date.now() / 1000),
          client_name: metadata.client_name?.slice(0, 120),
          redirect_uris: metadata.redirect_uris,
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          scope: MCP_SCOPE,
        }
        this.tokens.saveClient(client)
        return client
      },
    }
  }
  private callbackAllowed(uri: string): boolean {
    try {
      const url = new URL(uri)
      return (
        !url.username &&
        !url.password &&
        !url.hash &&
        this.settings.redirect_uris.some((allowed) => redirectUriMatches(uri, allowed))
      )
    } catch {
      return false
    }
  }
  private scopes(scopes?: string[]): void {
    if (scopes?.some((scope) => scope !== MCP_SCOPE))
      throw new InvalidScopeError('Scope no autorizado.')
  }
  private audience(resource?: URL): void {
    if (resource?.href !== this.resource)
      throw new InvalidRequestError('resource debe identificar este servidor MCP.')
  }
  private providerConfig(): Promise<oidc.Configuration> {
    this.provider ??= oidc
      .discovery(
        new URL(this.settings.oidc.issuer_url),
        this.settings.oidc.client_id,
        this.secret,
        undefined,
        {
          timeout: 10,
          execute: [
            oidc.enableNonRepudiationChecks,
            ...(new URL(this.settings.oidc.issuer_url).protocol === 'http:'
              ? [oidc.allowInsecureRequests]
              : []),
          ],
        },
      )
      .catch((error) => {
        this.provider = undefined
        throw error
      })
    return this.provider
  }
  private prune(): void {
    for (const [key, login] of this.logins) if (login.expires <= Date.now()) this.logins.delete(key)
    for (const [key, code] of this.codes) if (code.expires <= Date.now()) this.codes.delete(key)
    if (this.logins.size + this.codes.size >= MAX_PENDING)
      throw new TooManyRequestsError('Demasiadas solicitudes pendientes.')
  }
  private cookieName(id: string): string {
    return `${this.issuer.protocol === 'https:' ? '__Host-' : ''}regent-oauth-${id}`
  }
  private cookieOptions() {
    return {
      httpOnly: true,
      secure: this.issuer.protocol === 'https:',
      sameSite: 'lax' as const,
      path: '/',
      maxAge: LOGIN_MS,
    }
  }
  private login(req: express.Request, id: string): Login | undefined {
    const login = this.logins.get(id)
    const cookie =
      req.headers.cookie
        ?.split(';')
        .map((value) => value.trim())
        .find((value) => value.startsWith(this.cookieName(id) + '='))
        ?.split('=')
        .slice(1)
        .join('=') ?? ''
    return login && login.expires > Date.now() && equal(cookie, login.cookie) ? login : undefined
  }
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: express.Response,
  ): Promise<void> {
    this.audience(params.resource)
    this.scopes(params.scopes)
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge))
      throw new InvalidRequestError('PKCE S256 requerido.')
    this.prune()
    const provider = await this.providerConfig()
    const id = random(),
      cookie = random(),
      verifier = oidc.randomPKCECodeVerifier(),
      nonce = oidc.randomNonce()
    this.logins.set(id, {
      client,
      params,
      cookie,
      csrf: random(),
      verifier,
      nonce,
      phase: 'login',
      expires: Date.now() + LOGIN_MS,
    })
    res.cookie(this.cookieName(id), cookie, this.cookieOptions())
    res.redirect(
      oidc.buildAuthorizationUrl(provider, {
        redirect_uri: new URL('/oauth/callback', this.issuer).href,
        scope: 'openid email profile',
        state: id,
        nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
      }).href,
    )
  }
  private async callback(req: express.Request, res: express.Response): Promise<void> {
    const id = typeof req.query.state === 'string' ? req.query.state : ''
    const login = this.login(req, id)
    if (!login || login.phase !== 'login')
      return this.failure(res, 'La solicitud de acceso no es valida o ya fue usada.')
    login.phase = 'verifying'
    try {
      const token = await oidc.authorizationCodeGrant(
        await this.providerConfig(),
        new URL(req.originalUrl, this.issuer),
        {
          pkceCodeVerifier: login.verifier,
          expectedState: id,
          expectedNonce: login.nonce,
          idTokenExpected: true,
        },
      )
      const claims = token.claims()!
      if (
        typeof claims.sub !== 'string' ||
        !claims.sub ||
        typeof claims.email !== 'string' ||
        claims.email_verified !== true
      )
        throw new AccessDeniedError('Identidad no verificada.')
      const identity: OAuthIdentity = {
        issuer: claims.iss,
        sub: claims.sub,
        email: claims.email.trim().toLowerCase(),
        name: typeof claims.name === 'string' ? claims.name.slice(0, 300) : '',
      }
      if (!this.allowed(identity)) throw new AccessDeniedError('Usuario no autorizado.')
      login.identity = identity
      login.verifier = ''
      login.nonce = ''
      login.phase = 'consent'
      res.redirect('/oauth/consent?request=' + encodeURIComponent(id))
    } catch {
      this.logins.delete(id)
      res.clearCookie(this.cookieName(id), this.cookieOptions())
      this.failure(
        res,
        'No se pudo autorizar esta cuenta. Comprueba que tienes acceso y vuelve a conectar.',
      )
    }
  }
  private consent(req: express.Request, res: express.Response): void {
    const id = typeof req.body?.request === 'string' ? req.body.request : ''
    const login = this.login(req, id)
    if (
      !login ||
      login.phase !== 'consent' ||
      !login.identity ||
      typeof req.body.csrf !== 'string' ||
      !equal(req.body.csrf, login.csrf) ||
      req.headers.origin !== this.issuer.origin ||
      !['allow', 'deny'].includes(req.body.decision)
    )
      return this.failure(res, 'La confirmacion no es valida. Vuelve a conectar.')
    const destination = new URL(login.params.redirectUri)
    if (login.params.state) destination.searchParams.set('state', login.params.state)
    if (req.body.decision === 'deny') destination.searchParams.set('error', 'access_denied')
    if (req.body.decision === 'allow') {
      const code = random()
      this.codes.set(hash(code), {
        clientId: login.client.client_id,
        params: login.params,
        identity: login.identity,
        expires: Date.now() + CODE_MS,
      })
      destination.searchParams.set('code', code)
    }
    this.logins.delete(id)
    res.clearCookie(this.cookieName(id), this.cookieOptions())
    res.redirect(destination.href)
  }
  private code(client: OAuthClientInformationFull, code: string): Code {
    const stored = this.codes.get(hash(code))
    if (!stored || stored.expires <= Date.now() || stored.clientId !== client.client_id)
      throw new InvalidGrantError('Codigo invalido o vencido.')
    return stored
  }
  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
  ): Promise<string> {
    return this.code(client, code).params.codeChallenge
  }
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ) {
    this.audience(resource)
    const stored = this.code(client, code)
    if (redirectUri !== stored.params.redirectUri)
      throw new InvalidGrantError('Callback no coincide.')
    this.codes.delete(hash(code))
    return this.tokens.issue(client.client_id, stored.identity, this.resource)
  }
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refresh: string,
    scopes?: string[],
    resource?: URL,
  ) {
    this.audience(resource)
    this.scopes(scopes)
    return this.tokens.refresh(client.client_id, refresh, this.resource)
  }
  async verifyAccessToken(token: string) {
    const info = this.tokens.verify(token, this.resource)
    if (!this.clientsStore.getClient(info.clientId))
      throw new InvalidTokenError('Cliente no autorizado.')
    return info
  }
  async revokeToken(client: OAuthClientInformationFull, request: { token: string }) {
    this.tokens.revoke(client.client_id, request.token)
  }
  private failure(res: express.Response, message: string): void {
    this.page(res.status(403), 'No se pudo conectar', `<p>${escape(message)}</p>`)
  }
  private page(res: express.Response, title: string, body: string): void {
    res.type('html')
      .send(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(this.name)}</title>
      <style>body{font:15px/1.6 system-ui,sans-serif;color:#24232a;background:#f7f7f9;margin:0;padding:48px 24px}main{max-width:440px;margin:8vh auto;background:white;border:1px solid #e4e3e9;border-radius:16px;padding:32px}small{color:#6c6776}h1{font-size:24px;line-height:1.25;margin:16px 0}p{color:#57525e}button{font:inherit;padding:10px 18px;border:0;border-radius:8px;background:#7245dc;color:white;cursor:pointer;margin:12px 8px 0 0}.secondary{background:#efedf3;color:#36313f}</style>
      <main><small>${escape(this.name)}</small><h1>${escape(title)}</h1>${body}</main></html>`)
  }
}
