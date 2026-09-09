import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { z } from 'zod'
import { BRIDGE_DIR } from './env.ts'
import { resolveRepository } from './repository.ts'

const positive = z.number().positive().finite()
export const ConfigSchema = z.object({
  name: z.string().min(1).default('Regent'),
  auth: z.object({ mode: z.enum(['indie', 'team']) }),
  // bypass skips native permission rules; hooks are not a filesystem sandbox.
  // native: respeta allow/ask/deny del repo — en headless lo no permitido se auto-deniega.
  permission_mode: z.enum(['bypass', 'native']).default('bypass'),
  repos: z.object({
    path: z.string().min(1),
    workspace_root: z.string().min(1).nullable().default(null),
    default_repo: z.string().min(1).nullable().default(null),
    agent_env_files: z.array(z.string()).default([]),
    readonly_mcp: z.array(z.string()).default([]),
  }).strict(),
  slack: z.object({
    progress_mode: z.enum(['auto', 'plain']).default('auto'),
    workspace_team_id: z.string().min(1),
    allowed_users: z.array(z.string().min(1)).default([]),
  }).strict(),
  limits: z.object({
    max_concurrent_runs: z.number().int().min(1).max(32).default(3),
    max_run_sec: z.object({ ask: positive.default(600), patch: positive.default(1800), task: positive.default(3600) }).strict().prefault({}),
    stall_sec: positive.default(300),
    cancel_grace_sec: positive.default(60),
  }).prefault({}),
  budget: z.object({ max_cost_usd_per_run: positive.default(8), max_cost_usd_per_user_day: positive.default(25) }).prefault({}),
  session: z.object({ idle_reset_hours: positive.default(24) }).prefault({}),
  models: z.object({ ask: z.string().nullable().default(null), patch: z.string().nullable().default(null), task: z.string().nullable().default(null) }).strict().prefault({}),
}).strict()
export type Config = z.infer<typeof ConfigSchema>

export function authNotice(config: Config, env: NodeJS.ProcessEnv = process.env): string {
  if (config.auth.mode === 'team') return 'Modo equipo (team): usa ANTHROPIC_API_KEY, con facturacion por consumo.'
  const sharedAudience = new Set(config.slack.allowed_users).size !== 1
  if (sharedAudience) return [
    '------------------------------------------------------------',
    'ADVERTENCIA: ACCESO AMPLIADO EN MODO INDIVIDUAL',
    config.slack.allowed_users.length ? 'Varios usuarios autorizados a usar la misma cuenta.' : 'allowed_users: [] permite usuarios activos del workspace.',
    'Compartir la suscripcion puede causar suspension de la cuenta.',
    'Deja solo tu ID o usa auth.mode: team con ANTHROPIC_API_KEY.',
    'Terminos: https://www.anthropic.com/legal/consumer-terms',
    'El servidor continuara; esta advertencia no autoriza el uso.',
    ...(env.ANTHROPIC_API_KEY?.trim() ? ['ANTHROPIC_API_KEY presente: puede aplicar facturacion API.'] : []),
    '------------------------------------------------------------',
  ].join('\n')
  return [
    'Modo individual (indie): tu propio login en el binario oficial Claude Code con Pro/Max; un solo humano autorizado.',
    ...(env.ANTHROPIC_API_KEY?.trim() ? ['ANTHROPIC_API_KEY esta presente: Claude puede usar facturacion API en lugar de tu plan. Revisa la autenticacion del CLI.'] : []),
  ].join('\n')
}

export function assertAuth(config: Config, env: NodeJS.ProcessEnv = process.env): void {
  if (config.auth.mode === 'team' && !env.ANTHROPIC_API_KEY?.trim()) throw new Error('auth.mode team requiere ANTHROPIC_API_KEY en el servidor.')
}

export function loadConfig(file = process.env.REGENT_CONFIG ?? path.join(BRIDGE_DIR, 'config/regent.yaml')): Config {
  if (!fs.existsSync(file)) throw new Error(`No existe ${file}. Ejecuta pnpm regent setup --repo <ruta> --team <ID> --user <ID>.`)
  return ConfigSchema.parse(YAML.parse(fs.readFileSync(file, 'utf8')))
}

export function workspaceDir(config: Config): string {
  const root = fs.realpathSync(config.repos.path.replace(/^~(?=$|\/)/, process.env.HOME ?? ''))
  const dir = fs.realpathSync(path.resolve(root, config.repos.workspace_root ?? '.'))
  const relative = path.relative(root, dir)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.statSync(dir).isDirectory()) throw new Error('workspace_root debe ser una carpeta dentro de repos.path.')
  return dir
}

export function defaultRepoDir(config: Config, workspace: string): string {
  if (!config.repos.default_repo) return workspace
  try { return resolveRepository(workspace, config.repos.default_repo) }
  catch (cause) { throw new Error('repos.default_repo debe ser un repo dentro del workspace.', { cause }) }
}
