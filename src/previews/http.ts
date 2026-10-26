import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Previews, Preview } from './manager.ts'

function hostname(request: IncomingMessage): string {
  return (request.headers.host ?? '').toLowerCase().replace(/:\d+$/, '')
}

/** Client headers forwarded upstream, minus anything that could spoof auth or origin. */
function proxyHeaders(request: IncomingMessage): http.OutgoingHttpHeaders {
  const headers = { ...request.headers }

  for (const name of Object.keys(headers)) {
    if (name.startsWith('x-auth-') || name.startsWith('x-forwarded-')) delete headers[name]
  }

  headers['x-forwarded-proto'] = 'https'
  headers['x-forwarded-host'] = request.headers.host
  return headers
}

function proxyTo(preview: Preview, request: IncomingMessage): http.ClientRequest {
  return http.request({
    host: '127.0.0.1',
    port: preview.port,
    path: request.url,
    method: request.method,
    headers: proxyHeaders(request),
  })
}

function handleRequest(previews: Previews, request: IncomingMessage, response: ServerResponse) {
  response.setHeader('cache-control', 'no-store')
  const host = hostname(request)
  let url: URL

  try {
    url = new URL(request.url ?? '/', 'http://localhost')
  } catch {
    response.writeHead(400)
    return response.end()
  }

  // The TLS issuer asks, over loopback, whether a domain still maps to a live preview.
  if (host === '127.0.0.1' && url.pathname === '/_regent/tls') {
    const domain = url.searchParams.get('domain') ?? ''
    response.writeHead(request.method === 'GET' && previews.resolve(domain) ? 200 : 403)
    return response.end()
  }

  if (host === previews.config.domain) {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    return response.end('Previews de Regent. Abre el enlace del trabajo que quieres revisar.')
  }

  const preview = previews.resolve(host)

  if (!preview) {
    response.writeHead(404)
    return response.end('Preview no disponible o vencido.')
  }

  const upstream = proxyTo(preview, request)
  upstream.on('response', (result) => {
    response.writeHead(result.statusCode ?? 502, { ...result.headers, 'cache-control': 'no-store' })
    result.pipe(response)
  })
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502)
    response.end('La aplicacion de preview no esta disponible.')
  })
  request.on('aborted', () => upstream.destroy())
  request.pipe(upstream)
}

/** Relays the upstream's 101 response and then splices both sockets together. */
function spliceUpgrade(
  socket: Duplex,
  head: Buffer,
  response: IncomingMessage,
  peer: Duplex,
  upstreamHead: Buffer,
): void {
  socket.write(`HTTP/1.1 ${response.statusCode} Switching Protocols\r\n`)

  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    socket.write(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`)
  }

  socket.write('\r\n')
  if (upstreamHead.length) socket.write(upstreamHead)
  if (head.length) peer.write(head)
  peer.on('error', () => socket.destroy())
  socket.on('error', () => peer.destroy())
  peer.on('close', () => socket.destroy())
  socket.on('close', () => peer.destroy())
  socket.pipe(peer).pipe(socket)
}

function handleUpgrade(previews: Previews, request: IncomingMessage, socket: Duplex, head: Buffer) {
  const preview = previews.resolve(hostname(request))

  if (!preview) {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
    return
  }

  const upstream = proxyTo(preview, request)
  upstream.on('upgrade', (response, peer, upstreamHead) =>
    spliceUpgrade(socket, head, response, peer, upstreamHead),
  )
  upstream.on('response', (response) => {
    response.resume()
    socket.end(
      `HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? 'Bad Gateway'}\r\nConnection: close\r\n\r\n`,
    )
  })
  upstream.on('error', () => socket.destroy())
  upstream.end()
}

/** The preview proxy: one hostname per preview, forwarded to its local port, WebSockets included. */
export function createPreviewHttp(previews: Previews) {
  const server = http.createServer((request, response) =>
    handleRequest(previews, request, response),
  )

  server.on('upgrade', (request, socket, head) => handleUpgrade(previews, request, socket, head))
  return server
}
