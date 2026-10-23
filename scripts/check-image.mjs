import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createSystemPrompt } from '../src/execution/prompt.ts'
import { progressHtml } from '../src/adapters/mcp/progress.ts'
import { claudeVersion } from '../src/startup.ts'
const prompt = createSystemPrompt()
try {
  const content = fs.readFileSync(prompt.file, 'utf8')
  assert.match(content, /Instance Communication/)
  assert.ok(content.length > 100)
  assert.equal(fs.statSync(prompt.file).mode & 0o777, 0o600)
  assert.match(progressHtml('Container check'), /regent_get_run/)
  console.log('Container resources and official Claude CLI verified:', claudeVersion())
} finally {
  prompt.dispose()
}
