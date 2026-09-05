import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

if (process.env.REGENT_SMOKE !== '1') {
  console.error('Opt-in: REGENT_SMOKE=1 pnpm smoke. Usa Claude real y puede consumir saldo; requiere config/regent.yaml.')
  process.exit(1)
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'regent-smoke-'))
try {
  const child = spawn(process.execPath, ['src/v2/cli.ts', 'ask', 'Lee el README del repositorio y resume su proposito en tres frases, con una referencia de archivo. No hagas cambios.'], {
    stdio: 'inherit', env: { ...process.env, REGENT_DB: path.join(directory, 'smoke.sqlite') },
  })
  const result = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  process.exitCode = result ?? 1
} finally { fs.rmSync(directory, { recursive: true, force: true }) }
