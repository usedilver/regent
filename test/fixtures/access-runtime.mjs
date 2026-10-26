import fs from 'node:fs'
import path from 'node:path'

const { createRuntime } = await import(process.env.ACCESS_RUNTIME_MODULE)
const { ConfigSchema } = await import(process.env.ACCESS_CONFIG_MODULE)
const { Store } = await import(process.env.ACCESS_STORE_MODULE)
const config = ConfigSchema.parse({
  auth: { mode: 'team' },
  access_policy_file: path.resolve('config/access.yaml'),
  repos: { path: process.cwd() },
  slack: { workspace_team_id: 'T1' },
})
const output = { async notice() {}, async status() {}, async delta() {}, async finish() {} }
const runtime = createRuntime(config, {
  claudeVersion: 'fixture',
  port: 0,
  store: new Store(':memory:'),
  slack: { output, connected: () => true, async start() {}, async stop() {} },
})

await runtime.start()
const report = setInterval(() => {
  fs.writeFileSync(
    'status.json.tmp',
    JSON.stringify({ pid: process.pid, users: runtime.core.access.snapshot.slack.allowed_users }),
  )
  fs.renameSync('status.json.tmp', 'status.json')
}, 50)

process.on('SIGTERM', async () => {
  clearInterval(report)
  await runtime.close()
  process.exit(0)
})
