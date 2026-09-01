/** Tests del router de triggers (funciones puras). */
import assert from 'node:assert'
import { findMentionTargets, pageCreatedAgent, evaluateHandoff } from '../src/router.ts'

const config = {
  status_property: 'Status',
  max_hops: 2,
  states: [],
  agents: {
    planner: { allowed_tools: [], can_trigger: [], triggers: { mentions: ['@planner'], page_created: false } },
    implementer: { allowed_tools: [], can_trigger: [], triggers: { mentions: ['@implementer', '@dev'], page_created: false } },
    qa: { allowed_tools: [], can_trigger: ['implementer'], triggers: { mentions: ['@qa'], page_created: false } },
    triage: { allowed_tools: [], can_trigger: [], triggers: { mentions: [], page_created: true } },
  },
}

let failed = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`) } catch (err) { failed++; console.error(`  ✗ ${name}: ${err.message}`) }
}

console.log('router:')

check('encuentra mención simple y alias, case-insensitive', () => {
  assert.deepEqual(findMentionTargets('oye @QA revisa esto', config), ['qa'])
  assert.deepEqual(findMentionTargets('@dev ajusta el padding', config), ['implementer'])
  assert.deepEqual(findMentionTargets('sin menciones aquí', config), [])
})

check('múltiples menciones → orden de config', () => {
  assert.deepEqual(findMentionTargets('@qa y @planner véanlo', config), ['planner', 'qa'])
})

check('pageCreatedAgent encuentra a triage', () => {
  assert.equal(pageCreatedAgent(config), 'triage')
  assert.equal(pageCreatedAgent({ ...config, agents: { planner: config.agents.planner } }), undefined)
})

check('handoff permitido: qa→implementer dentro de hops', () => {
  const v = evaluateHandoff('qa', 'implementer', 0, config)
  assert.equal(v.ok, true)
  assert.equal(v.nextHop, 1)
})

check('handoff denegado: fuera de can_trigger', () => {
  const v = evaluateHandoff('planner', 'qa', 0, config)
  assert.equal(v.ok, false)
  assert.match(v.reason, /can_trigger/)
})

check('handoff denegado: max_hops alcanzado', () => {
  const v = evaluateHandoff('qa', 'implementer', 2, config)
  assert.equal(v.ok, false)
  assert.match(v.reason, /max_hops/)
})

check('handoff denegado: sin agente origen (card sin propiedad Agente)', () => {
  const v = evaluateHandoff(undefined, 'qa', 0, config)
  assert.equal(v.ok, false)
  assert.match(v.reason, /Agente/)
})

if (failed > 0) { console.error(`\n${failed} test(s) fallaron`); process.exit(1) }
console.log('router ✓\n')
