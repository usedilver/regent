import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { BRIDGE_DIR, loadEnv } from './env.ts'
import { assertAuth, loadConfig, workspaceDir } from './config.ts'
import { Core } from './core.ts'
import { Store } from './store.ts'
import { createHttp } from './http.ts'
import { ExternalMcp } from './mcp.ts'
import { mcpOutput } from './mcp-output.ts'
import { assertIsolationVersion } from './runner.ts'
import type { Server } from 'node:http'

loadEnv()
const config = loadConfig()
assertAuth(config)
const version = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 10000 }).trim()
assertIsolationVersion(version)
const store = new Store(process.env.REGENT_DB ?? path.join(BRIDGE_DIR, 'log/v2.sqlite'))
let core: Core | undefined
let server: Server | undefined
try {
  store.claimRuntime()
  core = new Core({ store, config, output: mcpOutput(store), cwd: workspaceDir(config), adapter: 'mcp' })
  const external = new ExternalMcp(core)
  server = createHttp(core, () => ({ slack_connected: false, claude_version: version, mcp_enabled: true }), external)
  await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(Number(process.env.REGENT_PORT ?? 8788), '127.0.0.1', resolve) })
  core.toolsUrl = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/tools`
  await core.recover()
  console.log(`Regent MCP en ${core.toolsUrl.replace('/tools', '/mcp')}`)
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await core!.close()
    await new Promise<void>(resolve => server!.close(() => resolve()))
    store.close()
  }
  process.on('SIGINT', () => { void close() })
  process.on('SIGTERM', () => { void close() })
} catch (error) {
  await core?.close()
  if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()))
  store.close()
  throw error
}
