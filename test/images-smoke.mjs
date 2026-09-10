import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { crc32, deflateSync } from 'node:zlib'
import { runnerInput } from '../src/runner.ts'

if (process.env.REGENT_SMOKE !== '1') throw new Error('Opt-in: REGENT_SMOKE=1 node test/images-smoke.mjs. Uses the official Claude CLI and may incur usage.')
// Synthetic red square: no user files or credentials enter the visual test payload.
function chunk(type, bytes) {
  const data = Buffer.concat([Buffer.from(type), bytes]), size = Buffer.alloc(4), checksum = Buffer.alloc(4)
  size.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(data))
  return Buffer.concat([size, data, checksum])
}
const header = Buffer.alloc(13); header.writeUInt32BE(64); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2
const pixels = Buffer.alloc(64 * (64 * 3 + 1))
for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) pixels[y * 193 + 1 + x * 3] = 255
const data = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regent-vision-smoke-'))
async function turn(prompt, sessionId, images) {
  const child = spawn('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--disable-slash-commands',
    '--system-prompt', 'Answer the visual question briefly. Do not use tools.', '--model', process.env.REGENT_SMOKE_MODEL ?? 'sonnet',
    ...(sessionId ? ['--resume', sessionId] : [])], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = '', stderr = ''
  child.stdout.on('data', d => { output += d }); child.stderr.on('data', d => { stderr += d })
  child.stdin.on('error', () => {})
  const content = images?.length ? runnerInput({ prompt, images }) : JSON.stringify({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null }) + '\n'
  child.stdin.end(content)
  const timer = setTimeout(() => child.kill('SIGKILL'), 90000)
  try {
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
    assert.equal(code, 0, stderr.slice(-1000))
    const events = output.trim().split('\n').map(l => JSON.parse(l))
    const result = events.findLast(e => e.type === 'result')
    assert.ok(result && !result.is_error, JSON.stringify(result))
    console.log(JSON.stringify({ state: 'completed', answer: result.result }))
    return { text: result.result, sessionId: events.find(e => e.type === 'system' && e.subtype === 'init')?.session_id ?? result.session_id }
  } finally { clearTimeout(timer) }
}
try {
  const first = await turn('What is the dominant color of the attached square? Answer one English color word.', undefined, [{ label: 'Synthetic test image', mediaType: 'image/png', data }])
  assert.match(first.text, /red/i); assert.ok(first.sessionId)
  const next = await turn('What color was the square attached in the previous turn? Answer one English color word.', first.sessionId)
  assert.match(next.text, /red/i)
  console.log('Real Claude CLI vision and resumed image context passed')
} finally { fs.rmSync(dir, { recursive: true, force: true }) }
