import { loadAccess } from './access.ts'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { REGENT_DIR, loadEnv } from './env.ts'
import { assertAuth, authNotice, loadConfig, workspaceDir } from './config.ts'
import { Store } from './storage/store.ts'
import { Core } from './core/core.ts'
import { createHttp } from './adapters/http.ts'
import type { Output } from './core/types.ts'
import { setup, requestArgs } from './setup.ts'

const USAGE =
  'Uso: pnpm regent setup --repo <ruta> --team <ID> --user <ID> | ask|patch <texto> [--repo <ruta>] [--conversation <id>] | runs | tail <run_id> [--follow]'
const RECENT_RUNS = 30
const TAIL_POLL_MS = 500

/** Replies land on stdout; there is no thread to update. */
const consoleOutput: Output = {
  async notice(_c, text) {
    console.log(text)
  },
  async status() {},
  async delta() {},
  async finish(_c, run, text) {
    console.log(`${text}\n\nrun: ${run.id}`)
  },
}

async function tailRun(store: Store, id: string, follow: boolean): Promise<void> {
  if (!store.run(id)) throw new Error('Run inexistente.')
  let cursor = 0

  while (true) {
    for (const event of store.eventsAfter(id, cursor)) {
      cursor = event.id
      console.log(`${event.kind}: ${event.data}`)
    }

    if (!follow || !['queued', 'running'].includes(store.run(id)!.state)) break
    await delay(TAIL_POLL_MS)
  }
}

/** The internal tools endpoint on a loopback port, so the CLI run can reach the core. */
async function listenLocally(core: Core): Promise<http.Server> {
  const server = createHttp(core, () => ({ slack_connected: false }))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  core.toolsUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tools`
  return server
}

async function runRequest(store: Store, intent: 'ask' | 'patch', args: string[]): Promise<number> {
  store.claimRuntime()
  const config = loadConfig()
  const { policy: access } = loadAccess(config)
  console.log(authNotice(config, process.env, access.snapshot.slack.allowed_users))
  assertAuth(config)
  const request = requestArgs(args)
  const conversation = request.conversation ?? randomUUID()
  const author = process.env.REGENT_USER_ID ?? access.snapshot.slack.allowed_users[0]

  if (!author) {
    throw new Error('Configura REGENT_USER_ID para atribuir consumo al usuario local.')
  }

  const core = new Core({
    store,
    config,
    access,
    output: consoleOutput,
    cwd: workspaceDir(config),
    adapter: 'cli',
  })
  const server = await listenLocally(core)

  const stop = () => {
    void core.close()
  }

  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  try {
    await core.recover()
    const accepted = await core.submit({
      adapter: 'cli',
      eventId: randomUUID(),
      key: `cli:${author}:${conversation}`,
      author,
      text: request.text,
      repo: request.repo,
      channel: conversation,
      intent,
    })

    while (core.active.size) {
      await Promise.allSettled([...core.active.values()].map((a) => a.done))
    }

    const failed =
      accepted.runId && ['failed', 'interrupted'].includes(store.run(accepted.runId)!.state)

    console.log(`conversation: ${conversation}`)
    return failed ? 1 : 0
  } finally {
    await core.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

async function runCommand(store: Store, command: string, args: string[]): Promise<number> {
  if (command === 'runs') {
    console.table(store.recentRuns(RECENT_RUNS))
    return 0
  }

  if (command === 'tail' && args[0]) {
    await tailRun(store, args[0], args.includes('--follow'))
    return 0
  }

  if ((command === 'ask' || command === 'patch') && args.length) {
    return runRequest(store, command, args)
  }

  console.log(USAGE)
  return 1
}

loadEnv()
const [command, ...args] = process.argv.slice(2)

if (command === 'setup') {
  console.log(setup(args))
} else {
  const store = new Store(process.env.REGENT_DB ?? path.join(REGENT_DIR, 'log/v2.sqlite'))

  try {
    process.exitCode = await runCommand(store, command, args)
  } finally {
    store.close()
  }
}
