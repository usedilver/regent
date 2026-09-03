/**
 * Ajustes globales de claude que un agente desatendido no puede contestar solo.
 * El primer arranque en modo bypass muestra un aviso ("Bypass Permissions mode…")
 * que espera Enter; `skipDangerousModePermissionPrompt` en la config de usuario
 * lo omite. Se siembra una vez; si el archivo está corrupto no se toca.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const USER_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')

export function ensureBypassAccepted(settingsPath = USER_SETTINGS_PATH): 'seeded' | 'already' | 'unreadable' {
  let settings: Record<string, unknown> = {}
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) } catch { return 'unreadable' }
  }
  if (settings.skipDangerousModePermissionPrompt === true) return 'already'
  settings.skipDangerousModePermissionPrompt = true
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
  return 'seeded'
}
