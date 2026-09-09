import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { BRIDGE_DIR, loadEnv } from './env.ts'
import { assertAuth, authNotice, loadConfig, workspaceDir } from './config.ts'
import { Store } from './store.ts'
import { Core } from './core.ts'
import { createHttp } from './http.ts'
import type { Output } from './types.ts'
import { setup, requestArgs } from './setup.ts'

loadEnv()
const [command, ...args] = process.argv.slice(2)
if (command === 'setup') {
  console.log(setup(args))
} else {
  const store = new Store(process.env.REGENT_DB ?? path.join(BRIDGE_DIR, 'log/v2.sqlite'))
  try {
    if (command === 'runs') {
      console.table(store.db.prepare('SELECT id,conversation_key,state,cost,error FROM runs ORDER BY created_at DESC LIMIT 30').all())
    } else if (command === 'tail' && args[0]) {
      const id = args[0]
      if (!store.run(id)) throw new Error('Run inexistente.')
      let cursor = 0
      while (true) {
        for (const event of store.db.prepare('SELECT * FROM events WHERE run_id=? AND id>? ORDER BY id').all(id, cursor)) {
          cursor = event.id as number
          console.log(`${event.kind}: ${event.data}`)
        }
        if (!args.includes('--follow') || !['queued', 'running'].includes(store.run(id)!.state)) break
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    } else if (['ask', 'patch'].includes(command) && args.length) {
      store.claimRuntime()
      const config = loadConfig()
      console.log(authNotice(config))
      assertAuth(config)
      const request = requestArgs(args)
      const conversation = request.conversation ?? randomUUID()
      const author = process.env.REGENT_USER_ID ?? config.slack.allowed_users[0]
      if (!author) throw new Error('Configura REGENT_USER_ID para atribuir consumo al usuario local.')
      const output: Output = {
        async notice(_c, text) { console.log(text) }, async status() {},
        async delta() {}, async finish(_c, run, text) { console.log(`${text}\n\nrun: ${run.id}`) },
      }
      const core = new Core({ store, config, output, cwd: workspaceDir(config), adapter: 'cli' })
      const server = createHttp(core, () => ({ slack_connected: false }))
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
      core.toolsUrl = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/tools`
      const stop = () => { void core.close() }
      process.on('SIGINT', stop); process.on('SIGTERM', stop)
      try {
        await core.recover()
        const accepted = await core.submit({ adapter: 'cli', eventId: randomUUID(), key: `cli:${author}:${conversation}`, author, text: request.text, repo: request.repo, channel: conversation, intent: command === 'patch' ? 'patch' : 'ask' })
        while (core.active.size) await Promise.allSettled([...core.active.values()].map(a => a.done))
        if (accepted.runId && ['failed', 'interrupted'].includes(store.run(accepted.runId)!.state)) process.exitCode = 1
        console.log(`conversation: ${conversation}`)
      } finally {
        await core.close()
        await new Promise<void>(resolve => server.close(() => resolve()))
        process.off('SIGINT', stop); process.off('SIGTERM', stop)
      }
    } else {
      console.log('Uso: pnpm regent setup --repo <ruta> --team <ID> --user <ID> | ask|patch <texto> [--repo <ruta>] [--conversation <id>] | runs | tail <run_id> [--follow]')
      process.exitCode = 1
    }
  } finally { store.close() }
}
