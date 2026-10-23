import { loadEnv } from './env.ts'
import { assertAuth, authNotice, loadConfig } from './config.ts'
import { createSlack } from './adapters/slack/adapter.ts'
import { createRuntime, installShutdown } from './runtime.ts'
import { claudeVersion } from './startup.ts'

loadEnv()
const config = loadConfig()
assertAuth(config)
if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_APP_TOKEN)
  throw new Error('Configura SLACK_BOT_TOKEN y SLACK_APP_TOKEN antes de iniciar Slack.')
const runtime = createRuntime(config, {
  slack: createSlack(config),
  claudeVersion: claudeVersion(),
})
console.log(authNotice(config, process.env, runtime.core.access.snapshot.slack.allowed_users))
installShutdown(runtime)
await runtime.start()
console.log(`${config.name} en ${runtime.core.toolsUrl.replace('/tools', '')}`)
