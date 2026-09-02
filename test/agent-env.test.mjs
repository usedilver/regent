/** Los .env de la instancia viajan literales a cada agente, sea cual sea el backend. */
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseEnvFile } from '../src/env.ts'
import { envFlags } from '../src/terminal.ts'

let failed = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`) } catch (err) { failed++; console.error(`  ✗ ${name}: ${err.message}`) }
}
const tmpEnv = (content) => { const f = path.join(os.tmpdir(), `ae-${Date.now()}-${Math.random().toString(36).slice(2)}.env`); fs.writeFileSync(f, content); return f }

console.log('agent-env:')

check('parsea KEY=VALUE, quita comillas envolventes, ignora comentarios y vacías', () => {
  const f = tmpEnv('# c\nA=1\nB="dos"\nC=\'tres\'\n\nexport D=4\n')
  assert.deepEqual(parseEnvFile(f), { A: '1', B: 'dos', C: 'tres', D: '4' })
  fs.rmSync(f)
})

check('un $ en el valor llega literal (sin expansión de shell)', () => {
  const f = tmpEnv('PASS=a$b$c\nURL="postgres://u:p$w@h/db"\n')
  const e = parseEnvFile(f)
  assert.equal(e.PASS, 'a$b$c')
  assert.equal(e.URL, 'postgres://u:p$w@h/db')
  fs.rmSync(f)
})

check('archivo inexistente → objeto vacío, no error', () => {
  assert.deepEqual(parseEnvFile('/nope/.env'), {})
})

check('envFlags: un flag por variable, formato K=V, orden estable', () => {
  assert.deepEqual(envFlags('--env', { A: '1', B: 'x y' }), ['--env', 'A=1', '--env', 'B=x y'])
  assert.deepEqual(envFlags('-e', undefined), [])
})

check('varios archivos: el último gana (merge en orden)', () => {
  const a = tmpEnv('X=1\nY=1\n'), b = tmpEnv('Y=2\n')
  const merged = Object.assign({}, parseEnvFile(a), parseEnvFile(b))
  assert.deepEqual(merged, { X: '1', Y: '2' })
  fs.rmSync(a); fs.rmSync(b)
})

if (failed) { console.error(`\n${failed} fallaron`); process.exit(1) }
