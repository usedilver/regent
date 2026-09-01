/** Tests del matcher tipo+propósito y la regla de necesidad derivada del workflow. */
import assert from 'node:assert'
import { detectProps, requiredRoleKeys, missingRequired, checkMappings, propShape } from '../src/board-detect.ts'

let failed = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`) } catch (err) { failed++; console.error(`  ✗ ${name}: ${err.message}`) }
}

console.log('board-detect:')

/** Board estilo cliente real: nombres propios, rollup, formula, cinco people. */
const board = {
  'Nombre del proyecto': { type: 'title' },
  'Status': { type: 'status', status: { options: [], groups: [] } },
  'Asignación': { type: 'people' },
  'Asignado a': { type: 'people' },
  'Team Lead': { type: 'people' },
  'Progress': { type: 'rollup' },
  'Order Type': { type: 'formula' },
  'Estimación': { type: 'rich_text' },
  'Type': { type: 'select', select: { options: [{ name: 'Bugs' }, { name: 'Quick Wins' }] } },
  'Ejecutor': { type: 'select', select: { options: [{ name: 'Agente' }, { name: 'Humano' }] } },
  'Repo': { type: 'url' },
  'PR': { type: 'url' },
  'Agente': { type: 'select', select: { options: [{ name: 'pm' }, { name: 'dev' }] } },
  'Hop': { type: 'number' },
}

check('matchea por tipo+propósito con los nombres del cliente', () => {
  const d = detectProps(board)
  assert.equal(d.repo_property, 'Repo')
  assert.equal(d.pr_property, 'PR')
  assert.equal(d.agent_property, 'Agente')
  assert.equal(d.hop_property, 'Hop')
  assert.deepEqual(d.agent_filter, { property: 'Ejecutor', skip_value: 'Humano' })
})

check('owner: prefiere "Asignado a" entre varias people; nunca inventa', () => {
  const d = detectProps(board)
  assert.equal(d.owner_property, 'Asignado a')
})

check('readOnly jamás se mapea: rollup Progress no es progress_property', () => {
  const d = detectProps(board)
  assert.equal(d.progress_property, null)
})

check('board vacío: todo null, nada de defaults inventados', () => {
  const d = detectProps({ 'Name': { type: 'title' } })
  for (const k of ['repo_property', 'pr_property', 'agent_property', 'hop_property', 'owner_property']) assert.equal(d[k], null)
  assert.equal(d.agent_filter, null)
})

check('claim-once: el filtro reclama "Agent Type" y agent_property no lo roba', () => {
  const d = detectProps({
    'Agent Type': { type: 'select', select: { options: [{ name: 'Humano' }, { name: 'Agente' }] } },
  })
  assert.deepEqual(d.agent_filter, { property: 'Agent Type', skip_value: 'Humano' })
  assert.equal(d.agent_property, null)
})

check('necesidad derivada del workflow: sin handoffs, agente+hop no son requeridas', () => {
  const req = requiredRoleKeys({ agents: { dev: { can_trigger: [] } } })
  assert.deepEqual([...req].sort(), ['pr_property', 'repo_property'])
})

check('necesidad derivada del workflow: con can_trigger, agente+hop pasan a requeridas', () => {
  const req = requiredRoleKeys({ agents: { pm: { can_trigger: ['dev'] }, dev: {} } })
  assert.ok(req.has('agent_property') && req.has('hop_property'))
})

check('missingRequired: solo huecos reales, lo existente no aparece', () => {
  const cfg = {
    repo_property: 'Repo', pr_property: 'PR',
    agent_property: 'Agente', hop_property: 'Hop',
    agent_filter: { property: 'Ejecutor', skip_value: 'Humano' },
    agents: { pm: { can_trigger: ['dev'] } },
  }
  assert.deepEqual(missingRequired(cfg, board), [])
  const holes = missingRequired(cfg, { 'Name': { type: 'title' } })
  assert.deepEqual(holes.map(h => h.name).sort(), ['Agente', 'Ejecutor', 'Hop', 'PR', 'Repo'])
})

check('missingRequired: sin handoffs no pide agente+hop', () => {
  const cfg = { repo_property: 'Repo', pr_property: 'PR', agent_property: 'Agente', hop_property: 'Hop', agents: {} }
  const holes = missingRequired(cfg, { 'Name': { type: 'title' } })
  assert.deepEqual(holes.map(h => h.name).sort(), ['PR', 'Repo'])
})

check('checkMappings: ausente, tipo incompatible y solo-lectura', () => {
  const cfg = {
    status_property: 'Status',
    repo_property: 'Repo',
    pr_property: 'NoExiste',
    progress_property: 'Progress',
    hop_property: 'Estimación',
  }
  const issues = Object.fromEntries(checkMappings(cfg, board).map(i => [i.key, i.problem]))
  assert.equal(issues.pr_property, 'ausente')
  assert.equal(issues.progress_property, 'solo-lectura')
  assert.equal(issues.hop_property, 'tipo')
  assert.equal(issues.repo_property, undefined)
})

check('propShape: las opciones de agente salen de los agents del workflow', () => {
  const shape = propShape('agent_property', { agents: { pm: {}, dev: {}, qa: {} } })
  assert.deepEqual(shape.select.options.map(o => o.name), ['pm', 'dev', 'qa'])
})

check('checkMappings: detecta project_doc_property inexistente', () => {
  const issues = checkMappings({ status_property: 'Status', project_doc_property: 'Proyecto Doc' }, board)
  const doc = issues.find(i => i.key === 'project_doc_property')
  assert.equal(doc?.problem, 'ausente')
})

check('checkMappings: acepta el doc de proyecto como relation o url', () => {
  const b = { ...board, 'Doc': { type: 'relation' }, 'Link': { type: 'url' } }
  for (const n of ['Doc', 'Link']) {
    const issues = checkMappings({ status_property: 'Status', project_doc_property: n }, b)
    assert.equal(issues.find(i => i.key === 'project_doc_property'), undefined, n)
  }
})

check('checkMappings: rechaza un doc de proyecto de tipo incompatible', () => {
  const issues = checkMappings({ status_property: 'Status', project_doc_property: 'Description' }, { ...board, Description: { type: 'rich_text' } })
  assert.equal(issues.find(i => i.key === 'project_doc_property')?.problem, 'tipo')
})

if (failed) { console.error(`\n${failed} fallaron`); process.exit(1) }
