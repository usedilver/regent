import { loadAccess, AccessReloader } from './access.ts'
import path from 'node:path'
import { Store } from './storage/store.ts'
import { Core } from './core/core.ts'
import { ExternalMcp } from './adapters/mcp/server.ts'
import { DurableOutput } from './storage/delivery.ts'
import { mcpOutput, routeMcpOutput } from './adapters/mcp/output.ts'
import { createHttp } from './adapters/http.ts'
import { startPreviewServer } from './previews/server.ts'
import { httpLifecycle } from './adapters/http-lifecycle.ts'
import { REGENT_DIR } from './env.ts'
import { authNotice, workspaceDir, type Config } from './config.ts'
import type { Output } from './core/types.ts'

export interface SlackAdapter {
  output: Output
  connected(): boolean
  start(core: Core): Promise<void>
  stop(): Promise<void>
}

export function runtimePort(value: string | undefined, previews: Config['previews']): number {
  const port = value === undefined ? 8788 : Number(value)
  if (!/^\d+$/.test(value ?? '8788') || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('REGENT_PORT debe ser un puerto entre 1 y 65535.')
  }
  if (
    previews &&
    (port === previews.listen_port || (port >= previews.port_min && port <= previews.port_max))
  ) {
    throw new Error('REGENT_PORT no puede coincidir con el gateway o los puertos de previews.')
  }
  return port
}

export function createRuntime(
  config: Config,
  options: {
    claudeVersion: string
    slack?: SlackAdapter
    store?: Store
    port?: number
  },
) {
  const port = options.port ?? runtimePort(process.env.REGENT_PORT, config.previews)
  const cwd = workspaceDir(config)
  const access = loadAccess(config)
  const store =
    options.store ?? new Store(process.env.REGENT_DB ?? path.join(REGENT_DIR, 'log/v2.sqlite'))
  try {
    store.claimRuntime()
    const slack = options.slack
    const durable = slack ? new DurableOutput(store, slack.output) : undefined
    const output = durable ? routeMcpOutput(durable, mcpOutput(store)) : mcpOutput(store)
    const core = new Core({
      store,
      config,
      access: access.policy,
      output,
      cwd,
      adapter: slack ? (config.mcp.enabled ? ['slack', 'mcp'] : 'slack') : 'mcp',
    })
    let recovered = false
    const accessReloader = access.file
      ? new AccessReloader(access.policy, access.file, {
          oauthRequired: Boolean(config.mcp.oauth),
          contentHash: access.contentHash,
          changed: (previous) => {
            if (recovered) core.pump()
            if (
              config.auth.mode === 'indie' &&
              core.access.snapshot.slack.allowed_users.length !== 1 &&
              previous.slack.allowed_users.join() !==
                core.access.snapshot.slack.allowed_users.join()
            )
              console.warn(
                authNotice(config, process.env, core.access.snapshot.slack.allowed_users),
              )
          },
        })
      : undefined
    const external = !slack || config.mcp.enabled ? new ExternalMcp(core) : undefined
    const server = createHttp(
      core,
      () => ({
        slack_connected: slack?.connected() ?? false,
        claude_version: options.claudeVersion,
        mcp_enabled: Boolean(external),
      }),
      external,
    )
    const http = httpLifecycle(server)
    let stopPreviews: (() => Promise<void>) | undefined
    let closing: Promise<void> | undefined
    const close = (): Promise<void> => {
      if (closing) return closing
      closing = (async () => {
        const errors: unknown[] = []
        const stop = async (action: () => unknown) => {
          try {
            await action()
          } catch (error) {
            errors.push(error)
          }
        }
        accessReloader?.close()
        await stop(() => core.close())
        await stop(() => stopPreviews?.())
        await stop(() => durable?.close())
        await stop(() => slack?.stop())
        await stop(() => http.close())
        await stop(() => store.close())
        if (errors.length)
          throw new AggregateError(errors, 'No se pudieron cerrar todos los recursos del runtime.')
      })()
      return closing
    }
    return {
      core,
      server,
      store,
      close,
      async start() {
        try {
          stopPreviews = await startPreviewServer(core)
          if (core.stopping) {
            await stopPreviews?.()
            throw new Error('El runtime se esta cerrando.')
          }
          await http.listen(port)
          if (core.stopping) throw new Error('El runtime se esta cerrando.')
          const address = server.address()
          if (!address || typeof address === 'string')
            throw new Error('No se pudo obtener el puerto del runtime.')
          core.toolsUrl = `http://127.0.0.1:${address.port}/tools`
          await slack?.start(core)
          if (core.stopping) throw new Error('El runtime se esta cerrando.')
          durable?.start()
          accessReloader?.reload()
          await core.recover()
          recovered = true
          accessReloader?.start()
        } catch (error) {
          try {
            await close()
          } catch (cleanup) {
            throw new AggregateError([error, cleanup], 'Fallo el arranque y su limpieza.')
          }
          throw error
        }
      },
    }
  } catch (error) {
    store.close()
    throw error
  }
}

export function installShutdown(runtime: Pick<ReturnType<typeof createRuntime>, 'close'>) {
  const close = () => {
    void runtime.close().catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
  return () => {
    process.removeListener('SIGINT', close)
    process.removeListener('SIGTERM', close)
  }
}
