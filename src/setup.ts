import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import YAML from 'yaml'
import { BRIDGE_DIR } from './env.ts'
import { ConfigSchema, authNotice } from './config.ts'
import { resolveRepository } from './repository.ts'

export function setup(args: string[], file = process.env.REGENT_CONFIG ?? path.join(BRIDGE_DIR, 'config/regent.yaml')): string {
  const { values } = parseArgs({ args, options: {
    repo: { type: 'string' }, workspace: { type: 'string' }, team: { type: 'string' },
    user: { type: 'string', multiple: true }, mode: { type: 'string', default: 'indie' },
    permissions: { type: 'string', default: 'bypass' },
  } })
  if (!values.repo || !values.team || !values.user?.length) throw new Error('Uso: pnpm regent setup --repo <ruta> --team <ID> --user <ID> [--workspace <ruta>] [--mode indie|team] [--permissions bypass|native]')
  if (!/^T[A-Z0-9]+$/.test(values.team) || values.user.some(user => !/^[UW][A-Z0-9]+$/.test(user))) throw new Error('Indica IDs de Slack validos para --team y --user.')
  const repo = fs.realpathSync(path.resolve(values.repo.replace(/^~(?=$|\/)/, process.env.HOME ?? '')))
  const workspace = fs.realpathSync(values.workspace ? path.resolve(values.workspace.replace(/^~(?=$|\/)/, process.env.HOME ?? '')) : path.dirname(repo))
  resolveRepository(workspace, repo)
  const minimal = { auth: { mode: values.mode }, permission_mode: values.permissions,
    repos: { path: workspace, default_repo: path.relative(workspace, repo) || '.' },
    slack: { workspace_team_id: values.team, allowed_users: [...new Set(values.user)] } }
  const config = ConfigSchema.parse(minimal)
  if (config.auth.mode === 'indie' && config.slack.allowed_users.length !== 1) throw new Error('indie requiere un solo usuario; usa --mode team para varias personas.')
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  try { fs.writeFileSync(file, YAML.stringify(minimal), { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Ya existe ${file}; no se sobrescribio. Edita ese archivo o elige otro con REGENT_CONFIG.`)
    throw error
  }
  return [`Configuracion creada: ${file}`, `Workspace: ${workspace}`, `Repo predeterminado: ${repo}`,
    `Permisos: ${config.permission_mode}${config.permission_mode === 'bypass' ? ' (no aplica allow/ask/deny nativos; los hooks no son un sandbox)' : ''}.`,
    authNotice(config), 'Configura SLACK_BOT_TOKEN y SLACK_APP_TOKEN en el entorno del servidor.',
    config.auth.mode === 'team' ? 'Configura ANTHROPIC_API_KEY en el servidor.' : 'Autentica el CLI oficial Claude Code con tu cuenta personal.',
    'Instala la app Slack con slack-manifest.json y ejecuta pnpm start. El setup no valida conexiones ni modifica los repositorios.'].join('\n')
}

export function requestArgs(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { repo: { type: 'string' }, conversation: { type: 'string' } } })
  if (!positionals.join(' ').trim() || values.repo === '' || values.conversation === '') throw new Error('ask/patch necesitan texto; --repo y --conversation necesitan valores no vacios.')
  return { text: positionals.join(' '), repo: values.repo, conversation: values.conversation }
}
