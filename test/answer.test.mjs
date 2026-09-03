/** La consulta técnica: prompt con reglas, repos y el hilo; sin card ni sala. */
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildAnswerPrompt, answerArgs } from '../src/answer.ts'
import { loadAgentEnv, agentEnvFiles } from '../src/env.ts'

let failed = 0
const check = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`) } catch (err) { failed++; console.error(`  ✗ ${name}: ${err.message}`) } }
console.log('answer:')

check('el prompt lleva la pregunta, los repos, el hilo y las reglas de respuesta corta con evidencia', () => {
  const p = buildAnswerPrompt({ text: '¿por qué el tag se pinta de ese color?', transcript: '**@ana:** mirá esto', repos: [{ name: 'frontend/frontend-hire' }], processNotes: 'Ramas desde develop.' })
  assert.match(p, /NO es una tarea/); assert.match(p, /- frontend\/frontend-hire/); assert.match(p, /¿por qué el tag/); assert.match(p, /\*\*@ana:\*\*/)
  assert.match(p, /archivo:línea/); assert.match(p, /no lo verifiqué/); assert.match(p, /Ramas desde develop/)
})

check('sin repos ni hilo: el prompt sigue válido', () => {
  const p = buildAnswerPrompt({ text: 'x', repos: [] })
  assert.match(p, /\(ninguno detectado\)/); assert.doesNotMatch(p, /Hilo de contexto/)
})

check('answerArgs: solo lectura del repo + los MCP del .mcp.json que aplica al cwd (hacia arriba), sin strict-mcp', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ans-'))
  const sub = path.join(root, 'backend', 'l9'); fs.mkdirSync(sub, { recursive: true })
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'database-prod': {}, n8n: {} } }))
  const args = answerArgs('sonnet', sub)
  const tools = args[args.indexOf('--allowed-tools') + 1].split(',')
  assert.ok(tools.includes('Read') && tools.includes('Bash(git log:*)'))
  assert.ok(tools.includes('mcp__database-prod') && tools.includes('mcp__n8n'))
  assert.ok(!tools.some(x => /Edit|Write/.test(x)))
  assert.ok(!args.includes('--strict-mcp-config'))
  assert.deepEqual(answerArgs('sonnet', undefined).slice(-1)[0].split(',').filter(x => x.startsWith('mcp__')), [])
  fs.rmSync(root, { recursive: true, force: true })
})

check('env: la lista configurada gana; sin lista, el .env de la raíz; sin raíz, nada — y el último archivo gana', () => {
  assert.deepEqual(agentEnvFiles(['~/a.env'], '/r'), ['~/a.env'])
  assert.deepEqual(agentEnvFiles([], '/r'), ['/r/.env'])
  assert.deepEqual(agentEnvFiles([], undefined), [])
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'env-'))
  fs.writeFileSync(path.join(d, 'a.env'), 'X=1\nY=1\n'); fs.writeFileSync(path.join(d, 'b.env'), 'Y=2\n')
  const r = loadAgentEnv([path.join(d, 'a.env'), path.join(d, 'b.env'), path.join(d, 'nope.env')])
  assert.deepEqual(r.vars, { X: '1', Y: '2' }); assert.deepEqual(r.files.map(f => f.count), [2, 1, 0])
  fs.rmSync(d, { recursive: true, force: true })
})

if (failed) { console.error(`\n${failed} fallaron`); process.exit(1) }
