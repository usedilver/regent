/** El .env guarda secretos: los permisos tienen que quedar 600 SIEMPRE, no solo al crearlo. */
console.log('env-perms:')
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const f = path.join(os.tmpdir(), `perm-${Date.now()}.env`)
fs.writeFileSync(f, 'A=1', { mode: 0o644 })
fs.writeFileSync(f, 'A=2', { mode: 0o600 })
assert.equal((fs.statSync(f).mode & 0o777).toString(8), '644', 'writeFileSync no baja permisos de un archivo existente')
fs.chmodSync(f, 0o600)
assert.equal((fs.statSync(f).mode & 0o777).toString(8), '600')
fs.rmSync(f)
console.log('  ✓ chmodSync es necesario: writeFileSync(mode) no aplica sobre archivo existente')
