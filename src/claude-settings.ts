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

/** Busca un archivo desde `from` hacia arriba, sin salir de $HOME. */
export function findUp(name: string, from: string): string | null {
  const home = process.env.HOME ?? '/'
  let cur = path.resolve(from)
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(cur, name)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(cur)
    if (parent === cur || cur === home) return null
    cur = parent
  }
  return null
}

export function ensureTrusted(dir: string): void {
  const cfgPath = path.join(process.env.HOME ?? '', '.claude.json')
  if (!fs.existsSync(cfgPath)) return // primer arranque global de claude: no interferir
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    cfg.projects ??= {}
    const proj = (cfg.projects[dir] ??= {})
    let changed = false

    if (proj.hasTrustDialogAccepted !== true) {
      proj.hasTrustDialogAccepted = true
      changed = true
      console.log(`[claude] trust pre-sembrado para ${dir}`)
    }

    // claude busca .mcp.json hacia ARRIBA: el agente corre en un submódulo
    // (…/talently-code/frontend/frontend-hire) y el archivo vive en la raíz del
    // monorepo. Mirar solo el cwd dejaba el diálogo sin pre-aprobar.
    const mcpPath = findUp('.mcp.json', dir)
    if (mcpPath) {
      const declared = Object.keys(JSON.parse(fs.readFileSync(mcpPath, 'utf8')).mcpServers ?? {})
      proj.enabledMcpjsonServers ??= []
      proj.disabledMcpjsonServers ??= []
      const nuevos = declared.filter(n =>
        !proj.enabledMcpjsonServers.includes(n) && !proj.disabledMcpjsonServers.includes(n))
      if (nuevos.length) {
        proj.enabledMcpjsonServers.push(...nuevos)
        changed = true
        console.log(`[claude] MCP del repo aprobados: ${nuevos.join(', ')}`)
      }
    }

    if (changed) fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
  } catch (err) {
    console.warn(`[claude] no pude sembrar trust/MCP (${(err as Error).message}); claude puede pedir confirmación`)
  }
}
