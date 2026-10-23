import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

async function main() {
  const token = process.env.REGENT_MCP_TOKEN?.trim()
  if (!token || token.length < 32)
    throw new Error('Configura REGENT_MCP_TOKEN con el token personal del conector.')
  const url = new URL(process.env.REGENT_MCP_URL ?? '')
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'REGENT_MCP_URL requiere HTTPS o HTTP loopback, sin credenciales, query ni fragmento.',
    )
  }
  const remote = new Client({ name: 'regent-desktop', version: '0.3.0' })
  try {
    await remote.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    )
    const local = new Server(remote.getServerVersion() ?? { name: 'regent', version: '0.3.0' }, {
      capabilities: { tools: {}, resources: {} },
      instructions: remote.getInstructions(),
    })
    local.setRequestHandler(ListToolsRequestSchema, (request, extra) =>
      remote.listTools(request.params, { signal: extra.signal }),
    )
    local.setRequestHandler(CallToolRequestSchema, (request, extra) =>
      remote.callTool(request.params, undefined, { signal: extra.signal }),
    )
    local.setRequestHandler(ListResourcesRequestSchema, (request, extra) =>
      remote.listResources(request.params, { signal: extra.signal }),
    )
    local.setRequestHandler(ReadResourceRequestSchema, (request, extra) =>
      remote.readResource(request.params, { signal: extra.signal }),
    )
    local.onclose = () => {
      void remote.close()
    }
    const close = () => {
      void local.close().finally(() => remote.close())
    }
    process.once('SIGINT', close)
    process.once('SIGTERM', close)
    await local.connect(new StdioServerTransport())
  } catch {
    await remote.close().catch(() => {})
    throw new Error(
      'No se pudo conectar al servidor de codigo. Verifica la URL, el token y la disponibilidad del servidor.',
    )
  }
}

main().catch((error) => {
  console.error((error as Error).message)
  process.exitCode = 1
})
