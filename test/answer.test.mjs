/** La consulta técnica: prompt con reglas, repos y el hilo; sin card ni sala. */
import assert from 'node:assert'
import { buildAnswerPrompt } from '../src/answer.ts'

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

if (failed) { console.error(`\n${failed} fallaron`); process.exit(1) }
