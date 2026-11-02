import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { startRunner } from '../../src/execution/runner.ts'

if (process.env.REGENT_SMOKE !== '1') {
  console.error(
    'Opt-in: REGENT_SMOKE=1 node test/smoke/background-waits.mjs. Uses official CLI/operator auth and normal provider usage.',
  )
  process.exit(1)
}

const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-background-smoke-')))
const token = randomBytes(32).toString('hex')
const server = http.createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end()
    return
  }
  if (request.url === '/tool-policy') {
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"reason":null}')
    return
  }
  const mcp = new McpServer({ name: 'background-smoke', version: '1.0.0' })
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  response.on('close', () => {
    void mcp.close()
  })
  await mcp.connect(transport)
  await transport.handleRequest(request, response)
})
let handle
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const results = []
  let background = false
  const stallMs = 20000
  handle = startRunner({
    cwd,
    command: 'claude',
    model: 'sonnet',
    runId: 'background-smoke',
    token,
    toolsUrl: `http://127.0.0.1:${server.address().port}/tools`,
    readonlyMcp: [],
    timeoutMs: 120000,
    stallMs,
    graceMs: 500,
    prompt:
      'Integration test: use Bash exactly once to run sleep 35; printf READY with run_in_background true and timeout 90000. Immediately end your turn with WAITING. Do not poll, schedule wakeups, delegate, read or modify files, or call other tools. When its completion notification arrives, respond READY. Use no external services other than this test conversation.',
    onEvent(event) {
      if (event.kind === 'tool_result' && event.background) background = true
      if (event.kind === 'result') {
        results.push({ text: event.text, at: Date.now() })
        console.log(`Received result ${results.length}; CLI still owns completion.`)
      }
    },
  })
  const result = await handle.done
  assert.equal(result.state, 'completed', result.error)
  assert.equal(background, true, 'The real CLI must launch background work')
  assert.ok(results.length >= 2, 'The parent must resume after background completion')
  assert.ok(
    results.at(-1).at - results[0].at > stallMs,
    'The quiet wait must exceed the inactivity window',
  )
  assert.match(result.text, /READY/)
  assert.doesNotMatch(result.text, /WAITING/)
  console.log(
    'PASS real CLI: quiet background task exceeds inactivity window, resumes and delivers its final result.',
  )
} finally {
  handle?.cancel()
  await handle?.done
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(cwd, { recursive: true, force: true })
}
