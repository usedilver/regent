/**
 * El prompt debe nombrar las propiedades del CLIENTE y sus valores exactos:
 * escribir "S" en un select cuyas opciones son "🟢 S" falla en silencio.
 */
import assert from 'node:assert'
import { buildPhasePrompt } from '../src/phase-prompt.ts'

let failed = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`) } catch (err) { failed++; console.error(`  ✗ ${name}: ${err.message}`) }
}
const base = { cardJson: '{}', pageId: 'x', ncardPath: './ncard', mode: 'column', nextState: 'In testing' }

console.log('prompt-props:')

check('nombra la propiedad del board y sus valores exactos', () => {
  const p = buildPhasePrompt({ ...base, props: { estimation: 'Effort', estimationValues: ['🟢 S', '🟡 M'], pr: 'PR' } })
  assert.match(p, /propiedad `Effort`/)
  assert.match(p, /`🟢 S`/)
  assert.doesNotMatch(p, /setselect <page_id> "Estimación"/)
})

check('board sin propiedad de estimación: le dice que no la invente', () => {
  const p = buildPhasePrompt({ ...base, props: { estimation: null, estimationValues: [], pr: 'PR' } })
  assert.match(p, /no la inventes/)
})

check('prohíbe duplicar en el cuerpo lo que vive en propiedades', () => {
  const p = buildPhasePrompt({ ...base, props: { estimation: 'Effort', estimationValues: ['🟢 S'], pr: 'PR' } })
  assert.match(p, /NO lo repitas en el cuerpo/)
  assert.match(p, /dos verdades/)
})

check('usa el nombre real de la propiedad de PR', () => {
  const p = buildPhasePrompt({ ...base, props: { estimation: null, estimationValues: [], pr: 'Pull Request' } })
  assert.match(p, /propiedad `Pull Request`/)
})

if (failed) { console.error(`\n${failed} fallaron`); process.exit(1) }
