import http from 'node:http'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Previews, Preview } from './previews.ts'

const claim = (value: unknown, key: string): unknown => key.split('.').reduce<unknown>((current, part) =>
  current && typeof current === 'object' && Object.hasOwn(current, part) ? (current as Record<string, unknown>)[part] : undefined, value)

function cookieToken(header: string, name: string): string | null {
  const values = header.split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`))
  if (values.length !== 1 || values[0].length > 8192) return null
  try {
    const decoded = decodeURIComponent(values[0].slice(name.length + 1))
    const token = decoded.startsWith('"') ? JSON.parse(decoded) : decoded
    return typeof token === 'string' && /^[a-z\d_-]+\.[a-z\d_-]+\.[a-z\d_-]+$/i.test(token) ? token : null
  } catch { return null }
}

export class PreviewAccess {
  private inFlight = new Map<string, Promise<boolean>>()
  readonly config: Previews['config']['auth']
  constructor(config: Previews['config']['auth']) { this.config = config }
  async allowed(request: IncomingMessage): Promise<boolean> {
    const token = cookieToken(request.headers.cookie ?? '', this.config.cookie_name)
    if (!token) return false
    const existing = this.inFlight.get(token)
    if (existing) return existing
    if (this.inFlight.size >= 100) return false
    const check = this.verify(token)
    this.inFlight.set(token, check)
    try { return await check } finally { this.inFlight.delete(token) }
  }
  private async verify(token: string): Promise<boolean> {
    try {
      const response = await fetch(this.config.verify_url, { headers: { accept: 'application/json', authorization: `Bearer ${token}` },
        redirect: 'error', signal: AbortSignal.timeout(5000) })
      if (!response.ok) { await response.body?.cancel(); return false }
      const payload: unknown = await response.json()
      if (!Object.entries(this.config.required_claims).every(([key, expected]) => claim(payload, key) === expected)) return false
      const email = claim(payload, this.config.email_claim)
      if (typeof email !== 'string' || email.split('@').length !== 2) return false
      return this.config.allowed_email_domains.includes(email.trim().toLowerCase().split('@')[1])
    } catch { return false }
  }
}

function hostname(request: IncomingMessage): string {
  return (request.headers.host ?? '').toLowerCase().replace(/:\d+$/, '')
}
function sameOrigin(request: IncomingMessage): boolean {
  return !request.headers.origin || request.headers.origin === `https://${request.headers.host}`
}
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)

function publicHeaders(request: IncomingMessage, allowedCookies: string[]): http.OutgoingHttpHeaders {
  const headers = { ...request.headers }
  const selected = (request.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => allowedCookies.includes(part.split('=')[0]))
  delete headers.cookie
  if (selected.length) headers.cookie = selected.join('; ')
  delete headers.authorization
  for (const name of Object.keys(headers)) if (name.startsWith('x-auth-') || name.startsWith('x-forwarded-')) delete headers[name]
  headers['x-forwarded-proto'] = 'https'
  headers['x-forwarded-host'] = request.headers.host
  return headers
}

export function createPreviewHttp(previews: Previews, access = new PreviewAccess(previews.config.auth)) {
  const proxy = (request: IncomingMessage, preview: Preview) => http.request({ host: '127.0.0.1', port: preview.port,
    path: request.url, method: request.method, headers: publicHeaders(request, previews.config.forward_cookie_names) })
  const server = http.createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store')
    const host = hostname(request)
    if (!sameOrigin(request)) { response.writeHead(403); return response.end() }
    let url: URL
    try { url = new URL(request.url ?? '/', 'http://localhost') }
    catch { response.writeHead(400); return response.end() }
    if (host === '127.0.0.1' && url.pathname === '/_regent/tls') {
      response.writeHead(request.method === 'GET' && previews.resolve(url.searchParams.get('domain') ?? '') ? 200 : 403)
      return response.end()
    }
    const preview = previews.resolve(host)
    if (host !== previews.config.domain && !preview) { response.writeHead(404); return response.end('Preview no disponible o vencido.') }
    if (!await access.allowed(request)) {
      response.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" })
      return response.end(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Acceso al preview</title><style>body{font:16px system-ui;max-width:480px;margin:15vh auto;padding:24px;color:#222}a{color:#6b42d8}</style><h1>Acceso al preview</h1><p>Necesitas una sesión corporativa autorizada. Inicia sesión y vuelve a este enlace.</p><p><a href="${escapeHtml(previews.config.auth.login_url)}" target="_blank" rel="noopener noreferrer">Iniciar sesión</a></p><p><a href="/">Ya inicié sesión · Reintentar</a></p></html>`)
    }
    if (!preview) { response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); return response.end('Previews de Regent. Abre el enlace del trabajo que quieres revisar.') }
    const current = previews.resolve(host)
    if (!current) { response.writeHead(410); return response.end('El preview ya no esta disponible.') }
    const upstream = proxy(request, current)
    upstream.on('response', result => {
      const headers = { ...result.headers, 'cache-control': 'no-store' }
      // Previews must not overwrite credentials shared by production sibling domains.
      const cookies = result.headers['set-cookie']?.filter(value => !/;\s*domain=/i.test(value))
      delete headers['set-cookie']
      if (cookies?.length) headers['set-cookie'] = cookies
      response.writeHead(result.statusCode ?? 502, headers); result.pipe(response)
    })
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end('La aplicacion de preview no esta disponible.') })
    request.on('aborted', () => upstream.destroy())
    request.pipe(upstream)
  })
  server.on('upgrade', async (request, socket: Duplex, head) => {
    const host = hostname(request)
    if (!sameOrigin(request) || !previews.resolve(host) || !await access.allowed(request)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return }
    const preview = previews.resolve(host)
    if (!preview) { socket.destroy(); return }
    const upstream = proxy(request, preview)
    upstream.on('upgrade', (response, peer, upstreamHead) => {
      socket.write(`HTTP/1.1 ${response.statusCode} Switching Protocols\r\n`)
      for (const [key, value] of Object.entries(response.headers)) if (value !== undefined && key !== 'set-cookie') socket.write(`${key}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`)
      socket.write('\r\n')
      if (upstreamHead.length) socket.write(upstreamHead)
      if (head.length) peer.write(head)
      peer.on('error', () => socket.destroy()); socket.on('error', () => peer.destroy())
      peer.on('close', () => socket.destroy()); socket.on('close', () => peer.destroy())
      socket.pipe(peer).pipe(socket)
    })
    upstream.on('response', () => socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'))
    upstream.on('error', () => socket.destroy())
    upstream.end()
  })
  return server
}
