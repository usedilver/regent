/**
 * El gate del agent_filter. Regla del board compartido: con run_value (opt-in)
 * un card que NO diga exactamente ese valor jamás se ejecuta — la mayoría de los
 * cards del equipo tienen la propiedad vacía.
 */
import assert from 'node:assert'

let failed = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`) } catch (err) { failed++; console.error(`  ✗ ${name}: ${err.message}`) }
}

// misma lógica que agentFilterGate en server.ts
function gate(filter, props) {
  if (!filter) return { ok: true }
  const fp = props?.[filter.property]
  const fv = fp?.select?.name ?? fp?.status?.name ?? (typeof fp?.checkbox === 'boolean' ? String(fp.checkbox) : null)
  if (filter.run_value) return { ok: fv === filter.run_value, reason: `${filter.property}=${fv ?? '(vacío)'}` }
  return { ok: fv !== filter.skip_value }
}
const optIn = { property: 'Ejecutor', run_value: 'Agente' }
const optOut = { property: 'Ejecutor', skip_value: 'Humano' }

console.log('agent-gate:')

check('opt-in: propiedad VACÍA no ejecuta (el caso de los cards del equipo)', () => {
  assert.equal(gate(optIn, {}).ok, false)
  assert.equal(gate(optIn, { Ejecutor: { select: null } }).ok, false)
})

check('opt-in: solo ejecuta con el valor exacto', () => {
  assert.equal(gate(optIn, { Ejecutor: { select: { name: 'Agente' } } }).ok, true)
  assert.equal(gate(optIn, { Ejecutor: { select: { name: 'Humano' } } }).ok, false)
  assert.equal(gate(optIn, { Ejecutor: { select: { name: 'agente' } } }).ok, false, 'no normaliza: el valor es exacto')
})

check('opt-in: sin props confirmadas NO ejecuta (ante la duda, no)', () => {
  assert.equal(gate(optIn, undefined).ok, false)
})

check('opt-out (histórico): vacío SÍ ejecuta — por eso no sirve en board compartido', () => {
  assert.equal(gate(optOut, {}).ok, true)
  assert.equal(gate(optOut, { Ejecutor: { select: { name: 'Humano' } } }).ok, false)
})

check('sin filtro configurado, no bloquea nada', () => {
  assert.equal(gate(null, {}).ok, true)
})

check('el motivo nombra la propiedad y su valor, para el comentario al humano', () => {
  assert.match(gate(optIn, {}).reason, /Ejecutor=\(vacío\)/)
})

if (failed) { console.error(`\n${failed} fallaron`); process.exit(1) }
