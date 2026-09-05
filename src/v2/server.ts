import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { BRIDGE_DIR, loadEnv } from '../env.ts'
import { assertAuth, authNotice, loadConfig, workspaceDir } from './config.ts'
import { Store } from './store.ts'
import { Core } from './core.ts'
import { createSlack } from './slack.ts'
import { createHttp } from './http.ts'
import { DurableOutput } from './delivery.ts'

loadEnv()
const config = loadConfig()
console.log(authNotice(config))
assertAuth(config)
const cwd = workspaceDir(config)
const claudeVersion = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 10000 }).trim()
const help = execFileSync('claude', ['--help'], { encoding: 'utf8', timeout: 10000 })
for (const flag of ['--permission-prompts', '--plugin-dir', '--include-partial-messages']) {
  if (!help.includes(flag)) throw new Error(`Actualiza Claude Code: falta ${flag}.`)
}
if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_APP_TOKEN) throw new Error('Configura SLACK_BOT_TOKEN y SLACK_APP_TOKEN antes de iniciar Slack v2.')
const store = new Store(process.env.REGENT_DB ?? path.join(BRIDGE_DIR, 'log/v2.sqlite'))
store.claimRuntime()
const slack = createSlack(config)
const output = new DurableOutput(store, slack.output)
const core = new Core({ store, config, output, cwd, adapter: 'slack' })
core.tasks.rooms = slack.rooms
let polling: Promise<void> | undefined
const poll = () => {
  if (!polling) polling = core.tasks.poll().catch(error => console.error('[v2 merge]', error.message)).finally(() => { polling = undefined; core.pump() })
}
let mergeTimer: NodeJS.Timeout | undefined
const server = createHttp(core, () => ({ slack_connected: slack.connected(), claude_version: claudeVersion }), poll)
const port = Number(process.env.REGENT_PORT ?? 8788)
try {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  core.toolsUrl = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/tools`
  await slack.start(core)
  output.start()
  await core.recover()
  mergeTimer = setInterval(poll, 60000)
  poll()
  console.log(`${config.name} v2 en http://127.0.0.1:${port}; ${claudeVersion}`)
} catch (error) {
  await core.close()
  clearInterval(mergeTimer)
  await polling
  await output.close()
  await slack.stop().catch(() => {})
  server.close()
  store.close()
  throw error
}
let closing = false
const close = async () => {
  if (closing) return
  closing = true
  clearInterval(mergeTimer)
  await core.close()
  await polling
  await output.close()
  await slack.stop()
  await new Promise<void>(resolve => server.close(() => resolve()))
  store.close()
}
process.on('SIGINT', () => { void close() })
process.on('SIGTERM', () => { void close() })
