import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startRunner } from '../src/execution/runner.ts'

test('agent runs disable the CLI auto memory, even when the operator enabled it', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'regent-runner-env-'))
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
  const script = `const emit = (x) => console.log(JSON.stringify(x));
emit({ type: 'system', subtype: 'init', session_id: 'fixture', mcp_servers: [] });
emit({ type: 'result', result: String(process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY), total_cost_usd: 0 });`
  const handle = startRunner({
    cwd,
    prompt: 'fixture',
    runId: 'fixture',
    toolsUrl: 'http://127.0.0.1:1/tools',
    token: 'synthetic',
    readonlyMcp: [],
    command: process.execPath,
    prefixArgs: ['-e', script, '--'],
    timeoutMs: 5000,
    env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' },
    onEvent() {},
  })
  assert.equal((await handle.done).text, '1')
})
