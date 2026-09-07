import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { BRIDGE_DIR } from '../env.ts'
import { ConfigSchema, authNotice } from './config.ts'
import { Store, redact } from './store.ts'

export function migrateConfig(legacy: any, env: NodeJS.ProcessEnv) {
  const users = (env.SLACK_INVITE_USERS?.split(',').map(s => s.trim()).filter(Boolean) ?? legacy.chat?.invite_users ?? []) as string[]
  return ConfigSchema.parse({
    name: legacy.name,
    auth: { mode: env.ANTHROPIC_API_KEY?.trim() || new Set(users).size > 1 ? 'team' : 'indie' },
    repos: { path: env.REPO_PATH, workspace_root: legacy.workspace_root, default_base_branch: legacy.default_base_branch,
      base_branches: legacy.repo_base_branches, agent_env_files: legacy.agent_env_files },
    slack: { workspace_team_id: env.SLACK_TEAM_ID || 'CONFIGURE_SLACK_TEAM_ID', allowed_users: users },
  })
}

export function importLegacy(store: Store, directory: string): number {
  let count = 0
  store.transaction(() => {
    for (const filename of ['rooms.json', 'threads.json']) {
      const file = path.join(directory, filename)
      if (!fs.existsSync(file)) continue
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      count += Number(store.db.prepare('INSERT OR IGNORE INTO legacy VALUES(?,?)').run(filename, redact(JSON.stringify(data))).changes)
      // Preserve links, never invent resumable Claude sessions from terminal refs.
      if (filename === 'threads.json') for (const [thread, task] of Object.entries(data)) {
        const separator = thread.indexOf(':')
        if (separator < 1 || typeof task !== 'string') continue
        const channel = thread.slice(0, separator), ts = thread.slice(separator + 1)
        store.db.prepare('INSERT OR IGNORE INTO conversations(key,adapter,channel,thread,author,cwd,updated_at,task_id) VALUES(?,?,?,?,?,?,?,?)')
          .run(`slack:${thread}`, 'slack', channel, ts, 'legacy', '', Date.now(), task)
      }
    }
  })
  return count
}

export function migrate() {
  const directory = process.env.BRIDGE_CONFIG_DIR ?? path.join(BRIDGE_DIR, 'config')
  const target = process.env.REGENT_CONFIG ?? path.join(directory, 'regent.yaml')
  if (!fs.existsSync(target)) {
    const legacy = JSON.parse(fs.readFileSync(path.join(directory, 'workflow.json'), 'utf8'))
    const config = migrateConfig(legacy, process.env)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, YAML.stringify(config), { flag: 'wx', mode: 0o600 })
  }
  const config = ConfigSchema.parse(YAML.parse(fs.readFileSync(target, 'utf8')))
  console.log(authNotice(config))
  if (config.auth.mode === 'indie' && !config.slack.allowed_users.length) {
    console.log('Antes de arrancar, configura slack.allowed_users con tu unico ID de Slack. La lista vacia no permite iniciar indie.')
  }
  const store = new Store(process.env.REGENT_DB ?? path.join(BRIDGE_DIR, 'log/v2.sqlite'))
  try {
    const imported = importLegacy(store, path.join(BRIDGE_DIR, 'log'))
    console.log(`Configuracion v2: ${target}; ${imported} registros legacy importados.`)
    console.log('Revisa slack.workspace_team_id, slack.allowed_users y auth.mode. La migracion no activa Slack ni cambia el board.')
  } finally { store.close() }
}
