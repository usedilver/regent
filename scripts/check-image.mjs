import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createSystemPrompt } from '../src/execution/prompt.ts'
import { progressHtml } from '../src/adapters/mcp/progress.ts'
import { claudeVersion } from '../src/startup.ts'
const prompt = createSystemPrompt()
const pythonEnvironment = fs.mkdtempSync(path.join(os.tmpdir(), 'regent-python-check-'))
try {
  const content = fs.readFileSync(prompt.file, 'utf8')
  assert.match(content, /Instance Communication/)
  assert.ok(content.length > 100)
  assert.ok(fs.existsSync(new URL('../plugins/executor/hooks/completion.mjs', import.meta.url)))
  assert.equal(fs.statSync(prompt.file).mode & 0o777, 0o600)
  assert.match(progressHtml('Container check'), /regent_get_run/)
  execFileSync('python3', ['-m', 'venv', pythonEnvironment])
  const python = path.join(pythonEnvironment, 'bin/python')
  assert.match(execFileSync(python, ['-m', 'pip', '--version'], { encoding: 'utf8' }), /^pip /)
  execFileSync(python, [
    '-c',
    'import csv, io, sqlite3; assert list(csv.DictReader(io.StringIO("name\\nexample\\n")))[0]["name"] == "example"; assert sqlite3.connect(":memory:").execute("select 1").fetchone() == (1,)',
  ])
  console.log('Container resources and official Claude CLI verified:', claudeVersion())
  console.log('Python scripts, venv and pip verified without installing external packages.')
} finally {
  prompt.dispose()
  fs.rmSync(pythonEnvironment, { recursive: true, force: true })
}
