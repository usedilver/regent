/**
 * Global Claude settings that an unattended agent cannot answer on its own. The first run in
 * bypass mode shows a "Bypass Permissions mode…" notice that waits for Enter;
 * `skipDangerousModePermissionPrompt` in the user settings skips it. Seeded once; a corrupt
 * file is left alone.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const USER_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')

export function ensureBypassAccepted(
  settingsPath = USER_SETTINGS_PATH,
): 'seeded' | 'already' | 'unreadable' {
  let settings: Record<string, unknown> = {}

  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    } catch {
      return 'unreadable'
    }
  }

  if (settings.skipDangerousModePermissionPrompt === true) return 'already'
  settings.skipDangerousModePermissionPrompt = true
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
  return 'seeded'
}

/** Walks up from `from` looking for a file, without leaving $HOME. */
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
  if (!fs.existsSync(cfgPath)) return // first global run of claude: stay out of the way

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

    // claude looks for .mcp.json upwards: the agent runs in a submodule while the file lives at
    // the monorepo root. Checking only the cwd left the dialog unapproved.
    const mcpPath = findUp('.mcp.json', dir)

    if (mcpPath) {
      const declared = Object.keys(JSON.parse(fs.readFileSync(mcpPath, 'utf8')).mcpServers ?? {})
      proj.enabledMcpjsonServers ??= []
      proj.disabledMcpjsonServers ??= []
      const added = declared.filter(
        (n) => !proj.enabledMcpjsonServers.includes(n) && !proj.disabledMcpjsonServers.includes(n),
      )

      if (added.length) {
        proj.enabledMcpjsonServers.push(...added)
        changed = true
        console.log(`[claude] MCP del repo aprobados: ${added.join(', ')}`)
      }
    }

    if (changed) fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
  } catch (err) {
    console.warn(
      `[claude] no pude sembrar trust/MCP (${(err as Error).message}); claude puede pedir confirmación`,
    )
  }
}
