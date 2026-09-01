/** Tests de `agent_stays`: fases que trabajan y NO mueven el card. */
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { makeBridgeFixture } from './fixture.mjs'
import { loadBridge } from '../src/bridge-config.ts'
import { buildPhasePrompt } from '../src/phase-prompt.ts'

let failed = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`) } catch (err) { failed++; console.error(`  ✗ ${name}: ${err.message}`) }
}
const withWorkflow = (mutate) => {
  const f = makeBridgeFixture()
  const p = path.join(f.configDir, 'config', 'workflow.json')
  const wf = JSON.parse(fs.readFileSync(p, 'utf8'))
  mutate(wf)
  fs.writeFileSync(p, JSON.stringify(wf))
  return { f, p }
}

console.log('stay-phase:')

check('acepta trigger sin agent_moves_to cuando agent_stays', () => {
  const { f } = withWorkflow(wf => {
    delete wf.states[1].agent_moves_to
    wf.states[1].agent_stays = true
  })
  const b = loadBridge(f.configDir)
  assert.equal(b.stateByName['Planning'].agent_stays, true)
  assert.equal(b.stateByName['Planning'].agent_moves_to, undefined)
  f.cleanup()
})

check('sigue rechazando trigger sin destino ni agent_stays (olvido real)', () => {
  const { f } = withWorkflow(wf => { delete wf.states[1].agent_moves_to })
  assert.throws(() => loadBridge(f.configDir), /tiene trigger pero no agent_moves_to/)
  f.cleanup()
})

check('rechaza agent_stays junto con agent_moves_to (contradictorio)', () => {
  const { f } = withWorkflow(wf => { wf.states[1].agent_stays = true })
  assert.throws(() => loadBridge(f.configDir), /excluyentes/)
  f.cleanup()
})

check('rechaza agent_stays en columna sin trigger', () => {
  const { f } = withWorkflow(wf => { wf.states[0].agent_stays = true })
  assert.throws(() => loadBridge(f.configDir), /sin trigger no significa nada/)
  f.cleanup()
})

check('prompt sin nextState: comentario obligatorio y prohibido mover', () => {
  const p = buildPhasePrompt({ cardJson: '{}', pageId: 'abc', ncardPath: './ncard', mode: 'column' })
  assert.match(p, /NO mueve el card/)
  assert.match(p, /NUNCA uses `move`/)
  assert.doesNotMatch(p, /el cambio de columna ES la notificación/)
})

check('prompt con nextState: se mantiene el protocolo de movimiento', () => {
  const p = buildPhasePrompt({ cardJson: '{}', pageId: 'abc', ncardPath: './ncard', mode: 'column', nextState: 'Testing' })
  assert.match(p, /`move` a \*\*"Testing"\*\*/)
  assert.match(p, /el cambio de columna ES la notificación/)
  assert.doesNotMatch(p, /NUNCA uses `move`/)
})

check('runPhase no rechaza una fase con agent_stays en modo columna', async () => {
  const { f } = withWorkflow(wf => {
    delete wf.states[1].agent_moves_to
    wf.states[1].agent_stays = true
  })
  const b = loadBridge(f.configDir)
  const st = b.config.states.find(s => s.trigger === 'planner')
  // misma condición que el guard de runPhase (launcher.ts): antes tiraba con agent_stays
  const rechazaria = !st?.agent_moves_to && !st?.agent_stays
  assert.equal(rechazaria, false)
  f.cleanup()
})

check('el estado se resuelve por trigger, no por la columna actual del card', () => {
  const { f } = withWorkflow(wf => {
    delete wf.states[1].agent_moves_to
    wf.states[1].agent_stays = true
  })
  const b = loadBridge(f.configDir)
  // dev mencionado con el card parado en "Planning" igual resuelve su propio estado
  const st = b.config.states.find(s => s.trigger === 'implementer')
  assert.equal(st.name, 'In Progress')
  assert.equal(st.use_worktree, true)
  f.cleanup()
})

if (failed) { console.error(`\n${failed} fallaron`); process.exit(1) }
