import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BRIDGE_DIR } from './env.ts'

export function createSystemPrompt(communicationFile?: string | null): { file: string; dispose(): void } {
  const selected = communicationFile
    ? path.resolve(BRIDGE_DIR, communicationFile.replace(/^~(?=$|\/)/, process.env.HOME ?? ''))
    : path.join(BRIDGE_DIR, 'plugin/communication.md')
  const communication = fs.readFileSync(selected, 'utf8').trim()
  if (!communication || Buffer.byteLength(communication) > 32768) {
    throw new Error('Las instrucciones de comunicacion deben contener texto y ocupar como maximo 32 KiB.')
  }
  const protocol = fs.readFileSync(path.join(BRIDGE_DIR, 'plugin/colleague.md'), 'utf8').trim()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'regent-prompt-'))
  const file = path.join(directory, 'system.md')
  const dispose = () => fs.rmSync(directory, { recursive: true, force: true })
  try {
    fs.writeFileSync(file, `${protocol}\n\n# Instance Communication\n\n${communication}\n`, { mode: 0o600 })
    return { file, dispose }
  } catch (error) {
    dispose()
    throw error
  }
}
