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

export interface RuntimeOptions {
  claudeVersion: string
  slack?: SlackAdapter
  store?: Store
  port?: number
  /** Bind address. Loopback unless a container needs to publish the port; see compose.yaml. */
  host?: string
}

const DEFAULT_PORT = 8788
const closingError = () => new Error('El runtime se esta cerrando.')

export function runtimePort(value: string | undefined, previews: Config['previews']): number {
  const port = value === undefined ? DEFAULT_PORT : Number(value)

  if (
    !/^\d+$/.test(value ?? String(DEFAULT_PORT)) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
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

function adapterFor(slack: SlackAdapter | undefined, config: Config): Core['adapter'] {
  if (!slack) return 'mcp'
  return config.mcp.enabled ? ['slack', 'mcp'] : 'slack'
}

/** Hot reload of the access policy on SIGHUP, available once the policy lives in its own file. */
function accessReloading(core: Core, config: Config, access: ReturnType<typeof loadAccess>) {
  let recovered = false

  const warnIfIndieUsersChanged = (previous: { slack: { allowed_users: readonly string[] } }) => {
    const users = core.access.snapshot.slack.allowed_users
    if (config.auth.mode !== 'indie' || users.length === 1) return
    if (previous.slack.allowed_users.join() === users.join()) return
    console.warn(authNotice(config, process.env, users))
  }

  const reloader = access.file
    ? new AccessReloader(access.policy, access.file, {
        oauthRequired: Boolean(config.mcp.oauth),
        changed: (previous) => {
          if (recovered) core.pump()
          warnIfIndieUsersChanged(previous)
        },
      })
    : undefined

  const onSignal = () => {
    if (core.stopping) return

    if (!reloader) {
      console.warn(
        'Access reload skipped: configure access_policy_file and restart once. Inline settings are boot-only.',
      )
      return
    }

    try {
      reloader.reload()
    } catch {
      console.error(
        'Access policy loaded; applying its effects failed. Check runtime health before retrying.',
      )
    }
  }

  return {
    onSignal,
    markRecovered() {
      recovered = true
    },
  }
}

/** Runs every step even when one fails, then reports all failures together. */
async function closeAll(steps: Array<() => unknown>): Promise<void> {
  const errors: unknown[] = []

  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      errors.push(error)
    }
  }

  if (errors.length) {
    throw new AggregateError(errors, 'No se pudieron cerrar todos los recursos del runtime.')
  }
}

export function createRuntime(config: Config, options: RuntimeOptions) {
  const port = options.port ?? runtimePort(process.env.REGENT_PORT, config.previews)
  const host = options.host ?? process.env.REGENT_HOST ?? '127.0.0.1'
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
      adapter: adapterFor(slack, config),
    })
    const reload = accessReloading(core, config, access)
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
      closing ??= (async () => {
        process.removeListener('SIGHUP', reload.onSignal)
        await closeAll([
          () => core.close(),
          () => stopPreviews?.(),
          () => durable?.close(),
          () => slack?.stop(),
          () => http.close(),
          () => store.close(),
        ])
      })()
      return closing
    }

    /** Brings every piece up in dependency order; a failure anywhere tears it all down again. */
    const start = async (): Promise<void> => {
      try {
        process.on('SIGHUP', reload.onSignal)
        stopPreviews = await startPreviewServer(core)

        if (core.stopping) {
          await stopPreviews?.()
          throw closingError()
        }

        await http.listen(port, host)
        if (core.stopping) throw closingError()
        const address = server.address()

        if (!address || typeof address === 'string') {
          throw new Error('No se pudo obtener el puerto del runtime.')
        }

        core.toolsUrl = `http://127.0.0.1:${address.port}/tools`
        await slack?.start(core)
        if (core.stopping) throw closingError()
        durable?.start()
        await core.recover()
        reload.markRecovered()
      } catch (error) {
        try {
          await close()
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'Fallo el arranque y su limpieza.')
        }

        throw error
      }
    }

    return { core, server, store, close, start }
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
