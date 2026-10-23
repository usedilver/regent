import type { Server } from 'node:http'
import type { Socket } from 'node:net'

export function httpLifecycle(server: Server) {
  const sockets = new Set<Socket>()
  let closing: Promise<void> | undefined
  let listening: Promise<void> | undefined
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  return {
    async listen(port: number) {
      if (closing) throw new Error('El servidor HTTP se esta cerrando.')
      listening = new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => { server.removeListener('listening', ready); reject(error) }
        const ready = () => { server.removeListener('error', failed); resolve() }
        server.once('error', failed)
        server.once('listening', ready)
        server.listen(port, '127.0.0.1')
      })
      await listening
    },
    close(): Promise<void> {
      if (closing) return closing
      closing = (async () => {
      await listening?.catch(() => {})
      await new Promise<void>((resolve, reject) => {
        if (!server.listening) { resolve(); return }
        server.close(error => error ? reject(error) : resolve())
        for (const socket of sockets) socket.destroy()
      })
      })()
      return closing
    },
  }
}
