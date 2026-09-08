type SocketClient = {
  autoReconnectEnabled: boolean
  on(event: string, listener: () => void): unknown
  start(): Promise<unknown>
}

// Own the retry promise: socket-mode 3.0.1's automatic reconnect can reject
// outside Bolt's error handler when apps.connections.open times out.
export class SlackConnection {
  connected = false
  private stopped = true
  private pending?: Promise<unknown>
  private timer?: ReturnType<typeof setTimeout>
  private failures = 0
  private client: SocketClient
  private report: (message: string) => void
  private retryMs: number

  constructor(client: SocketClient, report: (message: string) => void, retryMs = 5000) {
    this.client = client
    this.report = report
    this.retryMs = retryMs
    client.autoReconnectEnabled = false
    client.on('connected', () => {
      this.connected = !this.stopped
      this.failures = 0
    })
    client.on('disconnected', () => {
      this.connected = false
      this.schedule()
    })
  }

  async start(start: () => Promise<unknown>) {
    this.stopped = false
    this.pending = start()
    try { await this.pending }
    catch (error) { this.stopped = true; throw error }
    finally {
      this.pending = undefined
      if (!this.connected) this.schedule()
    }
  }

  private schedule() {
    if (this.stopped || this.connected || this.pending || this.timer) return
    const delay = Math.min(60000, this.retryMs * 2 ** Math.min(this.failures++, 4))
    this.report(`Slack desconectado; reintentando en ${delay / 1000}s.`)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.reconnect()
    }, delay)
  }

  private async reconnect() {
    if (this.stopped) return
    try {
      this.pending = this.client.start()
      await this.pending
      if (!this.stopped && this.connected) this.report('Conexion con Slack restablecida.')
    } catch (error) {
      this.connected = false
      this.report(`No se pudo reconectar a Slack: ${error instanceof Error ? error.message : 'conexion interrumpida'}`)
    } finally {
      this.pending = undefined
      this.schedule()
    }
  }

  async stop(stop: () => Promise<unknown>) {
    this.stopped = true
    this.connected = false
    clearTimeout(this.timer)
    this.timer = undefined
    // A pending URL request may create a socket after stop; drain it before
    // disconnecting so shutdown cannot leave that late socket alive.
    await this.pending?.catch(() => {})
    await stop()
  }
}
