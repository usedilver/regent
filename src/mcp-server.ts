import { loadEnv } from './env.ts'
import { assertAuth, loadConfig } from './config.ts'
import { createRuntime, installShutdown } from './runtime.ts'
import { claudeVersion } from './startup.ts'

loadEnv()
const config = loadConfig()
assertAuth(config)
if (!config.mcp.enabled) throw new Error('Activa mcp.enabled antes de iniciar el modo MCP.')
const runtime = createRuntime(config, { claudeVersion: claudeVersion() })
installShutdown(runtime)
await runtime.start()
console.log(`${config.name} MCP en ${runtime.core.toolsUrl.replace('/tools', '/mcp')}`)
