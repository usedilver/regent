import { randomUUID } from 'node:crypto'
const emit = value => process.stdout.write(JSON.stringify(value) + '\n')
let prompt = ''
for await (const chunk of process.stdin) prompt += chunk
const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? 'success'
const resume = process.argv.indexOf('--resume')
const session = resume >= 0 ? process.argv[resume + 1] : randomUUID()
emit({ type: 'system', subtype: 'init', session_id: session,
  mcp_servers: [{ name: 'regent', status: scenario === 'mcp-error' ? 'failed' : 'connected' }] })
if (scenario === 'malformed') process.stdout.write('not json\n')
if (scenario === 'hang' || scenario === 'ignore-signals') {
  process.on('SIGINT', () => { if (scenario !== 'ignore-signals') process.exit(130) })
  process.on('SIGTERM', () => { if (scenario !== 'ignore-signals') process.exit(143) })
  setInterval(() => {}, 1000)
} else {
  if (scenario === 'tool') {
    const config = JSON.parse(process.argv[process.argv.indexOf('--mcp-config') + 1]).mcpServers.regent
    const response = await fetch(config.url, { method: 'POST', headers: { ...config.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'regent_status', arguments: { text: 'Consultando el repositorio' } } }) })
    if (!response.ok) throw new Error(`Internal MCP: HTTP ${response.status}`)
  }
  const text = `Respuesta: ${prompt.trim()}`
  emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
  await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_CLAUDE_DELAY ?? 20)))
  if (scenario !== 'no-result') emit({ type: 'result', subtype: scenario === 'error' ? 'error_during_execution' : 'success',
    is_error: scenario === 'error', errors: scenario === 'error' ? ['fixture error'] : [], result: text, total_cost_usd: 0.02,
    usage: { input_tokens: 10, output_tokens: 5 }, permission_denials: [] })
}
