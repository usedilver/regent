import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { BackgroundTasks } from '../../src/execution/background-tasks.ts'
import { startRunner } from '../../src/execution/runner.ts'

if (process.env.REGENT_SMOKE !== '1') {
  console.error(
    'Opt-in: REGENT_SMOKE=1 node test/smoke/background-waits.mjs. Uses official CLI/operator auth and normal provider usage.',
  )
  process.exit(1)
}

const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regent-background-smoke-')))
const token = randomBytes(32).toString('hex')
let preparedReply
const server = http.createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end()
    return
  }
  if (request.url === '/tool-policy') {
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"reason":null}')
    return
  }
  if (request.url === '/completion-check') {
    let body = ''
    for await (const chunk of request) body += chunk
    const input = JSON.parse(body)
    const background = new BackgroundTasks()
    background.observe({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: input.background_tasks ?? [],
    })
    const verdict =
      preparedReply || background.running || handle?.hasBackgroundTasks?.()
        ? { decision: 'allow' }
        : {
            decision: 'block',
            reason: 'Save the verified READY result with regent_reply, then end.',
          }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(verdict))
    return
  }
  const mcp = new McpServer({ name: 'background-smoke', version: '1.0.0' })
  mcp.registerTool(
    'regent_reply',
    {
      description: 'Save the verified final reply after background work completes.',
      inputSchema: { text: z.string() },
    },
    async ({ text }) => {
      preparedReply = text
      return { content: [{ type: 'text', text: 'Saved. End the turn.' }] }
    },
  )
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
      'Integration test: use Bash exactly once to run sleep 35; printf READY with run_in_background true and timeout 90000. Immediately end your turn with WAITING. Do not poll, schedule wakeups, delegate, read or modify files. After its completion notification, save READY with regent_reply and end. Use no external services other than this test conversation.',
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
  assert.match(preparedReply, /READY/)
  assert.doesNotMatch(preparedReply, /WAITING/)
  console.log(
    'PASS real CLI: quiet background task exceeds inactivity window, resumes and saves only the verified final response.',
  )
} finally {
  handle?.cancel()
  await handle?.done
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(cwd, { recursive: true, force: true })
}
