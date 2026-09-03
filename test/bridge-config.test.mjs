/** Tests de carga y validación de workflow.json + agents/ (config de instancia). */
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeBridgeFixture } from './fixture.mjs'
import { loadBridge, parseAgentFile } from '../src/bridge-config.ts'

let failed = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`) } catch (err) { failed++; console.error(`  ✗ ${name}: ${err.message}`) }
}

console.log('bridge-config:')

check('carga fixture válido y expone triggers', () => {
  const f = makeBridgeFixture()
  const b = loadBridge(f.configDir)
  assert.equal(b.triggerStates.length, 2)
  assert.equal(b.stateByName['Planning'].trigger, 'planner')
  assert.equal(b.agents.get('planner').description, 'test planner')
  assert.match(b.agents.get('implementer').body, /implementer de prueba/)
  f.cleanup()
})

check('rechaza trigger que apunta a agent inexistente', () => {
  const f = makeBridgeFixture()
  fs.rmSync(path.join(f.configDir, 'agents', 'planner.md'))
  assert.throws(() => loadBridge(f.configDir), /trigger apunta al agent "planner"/)
  f.cleanup()
})

check('rechaza agent_moves_to a estado inexistente', () => {
  const f = makeBridgeFixture()
  const p = path.join(f.configDir, 'config', 'workflow.json')
  const wf = JSON.parse(fs.readFileSync(p, 'utf8'))
  wf.states[1].agent_moves_to = 'No Existe'
  fs.writeFileSync(p, JSON.stringify(wf))
  assert.throws(() => loadBridge(f.configDir), /agent_moves_to apunta a "No Existe"/)
  f.cleanup()
})

check('rechaza trigger sin agent_moves_to', () => {
  const f = makeBridgeFixture()
  const p = path.join(f.configDir, 'config', 'workflow.json')
  const wf = JSON.parse(fs.readFileSync(p, 'utf8'))
  delete wf.states[1].agent_moves_to
  fs.writeFileSync(p, JSON.stringify(wf))
  assert.throws(() => loadBridge(f.configDir), /tiene trigger pero no agent_moves_to/)
  f.cleanup()
})

check('detecta ciclos en can_trigger', () => {
  const f = makeBridgeFixture()
  const p = path.join(f.configDir, 'config', 'workflow.json')
  const wf = JSON.parse(fs.readFileSync(p, 'utf8'))
  wf.agents.planner.can_trigger = ['implementer']
  wf.agents.implementer.can_trigger = ['planner']
  fs.writeFileSync(p, JSON.stringify(wf))
  assert.throws(() => loadBridge(f.configDir), /ciclo en can_trigger/)
  f.cleanup()
})

check('rechaza campo desconocido en workflow.json (strict)', () => {
  const f = makeBridgeFixture()
  const p = path.join(f.configDir, 'config', 'workflow.json')
  const wf = JSON.parse(fs.readFileSync(p, 'utf8'))
  wf.states[0].tigger = 'typo'
  fs.writeFileSync(p, JSON.stringify(wf))
  assert.throws(() => loadBridge(f.configDir), /inválido/)
  f.cleanup()
})

check('rechaza configDir sin workflow.json', () => {
  const empty = fs.mkdtempSync('/tmp/bridge-empty-')
  assert.throws(() => loadBridge(empty), /falta .*workflow\.json/)
  fs.rmSync(empty, { recursive: true, force: true })
})

check('parseAgentFile: frontmatter + body', () => {
  const f = makeBridgeFixture()
  const a = parseAgentFile(path.join(f.configDir, 'agents', 'planner.md'))
  assert.equal(a.name, 'planner')
  assert.equal(a.tools, 'Read, Glob, Grep')
  assert.ok(!a.body.includes('---'))
  f.cleanup()
})

check('parseAgentFile: start_message del frontmatter (opcional)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-'))
  const f = path.join(dir, 'pm.md')
  fs.writeFileSync(f, '---\nname: pm\ndescription: x\nstart_message: 🔎 Investigando…\n---\ncuerpo')
  assert.equal(parseAgentFile(f).startMessage, '🔎 Investigando…')
  fs.writeFileSync(f, '---\nname: pm\ndescription: x\n---\ncuerpo')
  assert.equal(parseAgentFile(f).startMessage, undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---- permisos de los agentes ----

check('agent_permissions: default allowlist, acepta bypass, rechaza otra cosa', () => {
  const f = makeBridgeFixture()
  const wf = path.join(f.configDir, 'config', 'workflow.json')
  assert.equal(loadBridge(f.configDir).config.agent_permissions, 'allowlist')
  const raw = JSON.parse(fs.readFileSync(wf, 'utf8'))
  fs.writeFileSync(wf, JSON.stringify({ ...raw, agent_permissions: 'bypass' }))
  assert.equal(loadBridge(f.configDir).config.agent_permissions, 'bypass')
  fs.writeFileSync(wf, JSON.stringify({ ...raw, agent_permissions: 'yolo' }))
  assert.throws(() => loadBridge(f.configDir))
  f.cleanup()
})

// ---- config que migró de .env a workflow.json ----

check('defaults de propiedades: un workflow mínimo trae los nombres estándar', () => {
  const f = makeBridgeFixture()
  const c = loadBridge(f.configDir).config
  assert.equal(c.agent_property, 'Agente')
  assert.equal(c.hop_property, 'Hop')
  assert.equal(c.model_property, 'Modelo')
  assert.equal(c.progress_property, 'Progreso')
  assert.equal(c.owner_property, 'Owner')
  assert.deepEqual(c.chat, { invite_users: [], auto_invite_limit: 15 })
  assert.equal(c.intake.model, 'sonnet')
  assert.deepEqual(c.github.forward_repos, [])
  f.cleanup()
})

check('propiedades renombrables y anulables (board en otro idioma / sin ellas)', () => {
  const f = makeBridgeFixture()
  const p = path.join(f.configDir, 'config', 'workflow.json')
  const wf = JSON.parse(fs.readFileSync(p, 'utf8'))
  Object.assign(wf, { agent_property: 'Bot', hop_property: null, owner_property: 'Assignee' })
  fs.writeFileSync(p, JSON.stringify(wf))
  const c = loadBridge(f.configDir).config
  assert.equal(c.agent_property, 'Bot')
  assert.equal(c.hop_property, null, 'null = el board no tiene esa propiedad')
  assert.equal(c.owner_property, 'Assignee')
  f.cleanup()
})

check('github.forward_repos acepta "auto" o lista, y rechaza otra cosa', () => {
  const f = makeBridgeFixture()
  const p = path.join(f.configDir, 'config', 'workflow.json')
  const wf = JSON.parse(fs.readFileSync(p, 'utf8'))
  const load = value => {
    wf.github = { forward_repos: value }
    fs.writeFileSync(p, JSON.stringify(wf))
    return loadBridge(f.configDir).config.github.forward_repos
  }
  assert.equal(load('auto'), 'auto')
  assert.deepEqual(load(['o/r']), ['o/r'])
  assert.throws(() => load('todos'), /workflow\.json inválido/)
  f.cleanup()
})

check('csvEnvOr: env vacía NO pisa la config; con valor sí', async () => {
  const { csvEnvOr } = await import('../src/bridge-config.ts')
  const prev = process.env.TEST_CSV
  process.env.TEST_CSV = ''
  assert.deepEqual(csvEnvOr('TEST_CSV', ['de-config']), ['de-config'])
  process.env.TEST_CSV = 'a, b'
  assert.deepEqual(csvEnvOr('TEST_CSV', ['de-config']), ['a', 'b'])
  delete process.env.TEST_CSV
  if (prev !== undefined) process.env.TEST_CSV = prev
})

if (failed > 0) { console.error(`\n${failed} test(s) fallaron`); process.exit(1) }
console.log('bridge-config ✓\n')
