/** Un eco de propiedades solo es "movimiento" si el status cambió respecto a uno YA conocido. */
import assert from 'node:assert'
const isRealMove = (prev, now) => prev !== undefined && prev !== now  // misma lógica que server.ts
let failed = 0
const check = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`) } catch (err) { failed++; console.error(`  ✗ ${name}: ${err.message}`) } }
console.log('real-move:')
check('primera observación no es movimiento (card recién creado + eco del launcher)', () => assert.equal(isRealMove(undefined, 'Despriorizado'), false))
check('mismo status no es movimiento (dev escribió PR)', () => assert.equal(isRealMove('In development', 'In development'), false))
check('status distinto conocido sí es movimiento', () => assert.equal(isRealMove('In development', 'In testing'), true))
if (failed) { console.error(`\n${failed} fallaron`); process.exit(1) }
