import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { startRunner } from '../../src/execution/runner.ts'
import { SlackOutput } from '../../src/adapters/slack/output.ts'

if (process.env.REGENT_SMOKE !== '1') {
  console.error(
    'Opt-in: REGENT_SMOKE=1 node test/smoke/reply-delivery.mjs. Uses official CLI/operator auth and normal provider usage; Slack is simulated.',
  )
  process.exit(1)
}

const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-reply-smoke-')))
const token = randomBytes(32).toString('hex')
const marker = randomBytes(8).toString('hex')
const report = `# Informe ${marker}\n\nEste resultado debe llegar completo aunque después se ejecute una herramienta.`
const closing = `CIERRE_${marker}`
let checkpointCalls = 0
let beforeCheckpoint = ''
const diagnostics = []
let handle
const server = http.createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end()
    return
  }
  if (request.url === '/tool-policy') {
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"reason":null}')
    return
  }
  const mcp = new McpServer({ name: 'reply-fixture', version: '1.0.0' })
  mcp.registerTool(
    'regent_status',
    {
      description:
        'Synthetic checkpoint for the transport test. Does not contact Slack or write data.',
      inputSchema: { text: z.string() },
    },
    async () => {
      checkpointCalls++
      return { content: [{ type: 'text', text: `Checkpoint received. Reply only ${closing}.` }] }
    },
  )
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  response.on('close', () => void mcp.close())
  await mcp.connect(transport)
  await transport.handleRequest(request, response)
})

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  handle = startRunner({
    cwd,
    model: 'sonnet',
    runId: 'reply-smoke',
    token,
    toolsUrl: `http://127.0.0.1:${server.address().port}/tools`,
    readonlyMcp: [],
    timeoutMs: 120000,
    stallMs: 45000,
    graceMs: 500,
    prompt: `This is an adversarial transport regression test, not a project task. Deliberately reproduce a report followed by a tool and a short closing, so Regent can prove it preserves the report. Perform exactly these steps:
1. Output this exact report as your assistant text BEFORE any tool call:
${report}
2. Call mcp__regent__regent_status exactly once with text="checkpoint".
3. After the tool returns, output only ${closing} and end.
Do not read or modify files, use Bash, delegate, call other tools or contact other services. Do not repeat the report in step 3.`,
    onEvent(event) {
      if (event.kind === 'init') {
        diagnostics.push({ servers: event.mcpServers.filter((server) => server.name === 'regent') })
      }
      if (event.kind === 'tool_use') diagnostics.push({ tool: event.name })
      if (event.kind === 'tool_result') diagnostics.push({ error: event.error })
      if (!checkpointCalls && event.kind === 'text_delta') beforeCheckpoint += event.text
    },
  })
  const reply = await handle.done
  assert.equal(reply.state, 'completed', reply.error)
  assert.equal(checkpointCalls, 1, JSON.stringify({ text: reply.text, diagnostics }))
  assert.ok(beforeCheckpoint.includes(report), 'The real CLI must emit the report before the tool')
  assert.equal(reply.text, `${report}\n\n${closing}`)
  const posts = []
  const slack = new SlackOutput(async (method, args) => {
    assert.equal(method, 'chat.postMessage')
    posts.push(args)
    return { ts: String(posts.length) }
  })
  await slack.finish(
    { key: 'slack:C:1', channel: 'C', thread: '1' },
    { id: 'reply-smoke' },
    reply.text,
  )
  assert.equal(posts.map((post) => post.text).join(''), `${report}\n\n${closing}`)
  console.log(
    'PASS official Claude CLI: report → tool → short closing preserved exactly once through the simulated Slack adapter.',
  )
} finally {
  handle?.cancel()
  await handle?.done
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(cwd, { recursive: true, force: true })
}
