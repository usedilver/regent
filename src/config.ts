import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { z } from 'zod'
import { expandHome, REGENT_DIR } from './env.ts'
import { isInside, projectRoot } from './core/repository.ts'

const positive = z.number().positive().finite()
const authUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value)
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    )
  }, 'Usa HTTPS o HTTP loopback, sin credenciales, query ni fragmento.')

export const ConfigSchema = z
  .object({
    name: z.string().min(1).default('Regent'),
    access_policy_file: z.string().trim().min(1).nullable().default(null),
    auth: z.object({ mode: z.enum(['indie', 'team']) }),
    // bypass skips the native permission rules; hooks are not a filesystem sandbox.
    // native honors the repo's allow/ask/deny; headless runs auto-deny anything not allowed.
    permission_mode: z.enum(['bypass', 'native']).default('bypass'),
    communication: z
      .object({
        instructions_file: z.string().trim().min(1).nullable().default(null),
      })
      .strict()
      .prefault({}),
    previews: z
      .object({
        domain: z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/),
        listen_port: z.number().int().min(1024).max(65535).default(8791),
        port_min: z.number().int().min(1024).max(65535).default(32000),
        port_max: z.number().int().min(1024).max(65535).default(32009),
        max_active: z.number().int().min(1).max(20).default(3),
        ttl_minutes: z.number().int().min(5).max(1440).default(120),
      })
      .strict()
      .refine(
        (value) =>
          value.port_min <= value.port_max &&
          value.port_max - value.port_min < 100 &&
          (value.listen_port < value.port_min || value.listen_port > value.port_max),
        'Rango de puertos de preview invalido.',
      )
      .nullable()
      .default(null),
    repos: z
      .object({
        path: z.string().min(1),
        workspace_root: z.string().min(1).nullable().default(null),
        default_repo: z.string().min(1).nullable().default(null),
        agent_env_files: z.array(z.string()).default([]),
        readonly_mcp: z.array(z.string()).default([]),
      })
      .strict(),
    slack: z
      .object({
        progress_mode: z.enum(['auto', 'plain']).default('auto'),
        workspace_team_id: z.string().min(1),
        allowed_users: z.array(z.string().min(1)).default([]),
      })
      .strict(),
    mcp: z
      .object({
        enabled: z.boolean().default(false),
        principals: z
          .array(
            z
              .object({
                id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
                token_env: z.string().regex(/^REGENT_MCP_TOKEN_[A-Z0-9_]+$/),
              })
              .strict(),
          )
          .default([]),
        oauth: z
          .object({
            issuer_url: authUrl.refine(
              (value) => new URL(value).pathname === '/',
              'El issuer debe estar en la raiz del dominio.',
            ),
            trust_proxy: z.enum(['none', 'loopback']).default('none'),
            redirect_uris: z.array(authUrl).min(1).max(20),
            oidc: z
              .object({
                issuer_url: authUrl,
                client_id: z.string().min(1),
                client_secret_env: z.string().regex(/^REGENT_[A-Z0-9_]+$/),
                allowed_emails: z
                  .array(
                    z
                      .string()
                      .email()
                      .transform((value) => value.toLowerCase()),
                  )
                  .min(1)
                  .max(1000)
                  .optional(),
              })
              .strict(),
          })
          .strict()
          .nullable()
          .default(null),
      })
      .strict()
      .prefault({}),
    limits: z
      .object({
        max_concurrent_runs: z.number().int().min(1).max(32).default(3),
        max_run_sec: z
          .object({
            ask: positive.default(600),
            patch: positive.default(1800),
            task: positive.default(3600),
            project: positive.default(7200),
          })
          .strict()
          .prefault({}),
        stall_sec: positive.default(300),
        cancel_grace_sec: positive.default(60),
      })
      .prefault({}),
    budget: z
      .object({
        max_cost_usd_per_run: positive.default(8),
        max_cost_usd_per_user_day: positive.default(25),
      })
      .prefault({}),
    session: z.object({ idle_reset_hours: positive.default(24) }).prefault({}),
    models: z
      .object({
        ask: z.string().nullable().default(null),
        patch: z.string().nullable().default(null),
        task: z.string().nullable().default(null),
        project: z.string().nullable().default(null),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.mcp.oauth && !config.access_policy_file && !config.mcp.oauth.oidc.allowed_emails) {
      context.addIssue({
        code: 'custom',
        path: ['mcp', 'oauth', 'oidc', 'allowed_emails'],
        message: 'Configure inline allowed_emails or access_policy_file.',
      })
    }
  })
export type Config = z.infer<typeof ConfigSchema>

export function authNotice(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
  users: readonly string[] = config.slack.allowed_users,
): string {
  if (config.auth.mode === 'team') {
    return 'Modo equipo (team): usa ANTHROPIC_API_KEY, con facturacion por consumo.'
  }

  const sharedAudience = new Set(users).size !== 1

  if (sharedAudience) {
    return [
      '------------------------------------------------------------',
      'ADVERTENCIA: ACCESO AMPLIADO EN MODO INDIVIDUAL',
      users.length
        ? 'Varios usuarios autorizados a usar la misma cuenta.'
        : 'allowed_users: [] permite usuarios activos del workspace.',
      'Compartir la suscripcion puede causar suspension de la cuenta.',
      'Deja solo tu ID o usa auth.mode: team con ANTHROPIC_API_KEY.',
      'Terminos: https://www.anthropic.com/legal/consumer-terms',
      'El servidor continuara; esta advertencia no autoriza el uso.',
      ...(env.ANTHROPIC_API_KEY?.trim()
        ? ['ANTHROPIC_API_KEY presente: puede aplicar facturacion API.']
        : []),
      '------------------------------------------------------------',
    ].join('\n')
  }

  return [
    'Modo individual (indie): tu propio login en el binario oficial Claude Code con Pro/Max; un solo humano autorizado.',
    ...(env.ANTHROPIC_API_KEY?.trim()
      ? [
          'ANTHROPIC_API_KEY esta presente: Claude puede usar facturacion API en lugar de tu plan. Revisa la autenticacion del CLI.',
        ]
      : []),
  ].join('\n')
}

export function assertAuth(config: Config, env: NodeJS.ProcessEnv = process.env): void {
  if (config.auth.mode === 'team' && !env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error('auth.mode team requiere ANTHROPIC_API_KEY en el servidor.')
  }
}

export function loadConfig(
  file = process.env.REGENT_CONFIG ?? path.join(REGENT_DIR, 'config/regent.yaml'),
): Config {
  if (!fs.existsSync(file)) {
    throw new Error(
      `No existe ${file}. Ejecuta pnpm regent setup --repo <ruta> --team <ID> --user <ID>.`,
    )
  }

  return ConfigSchema.parse(YAML.parse(fs.readFileSync(file, 'utf8')))
}

export function workspaceDir(config: Config): string {
  const root = fs.realpathSync(expandHome(config.repos.path))
  const dir = fs.realpathSync(path.resolve(root, config.repos.workspace_root ?? '.'))

  if (!isInside(root, dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error('workspace_root debe ser una carpeta dentro de repos.path.')
  }

  return dir
}

export function defaultRepoDir(config: Config, workspace: string): string {
  if (!config.repos.default_repo) return workspace

  try {
    return projectRoot(workspace, config.repos.default_repo)
  } catch (cause) {
    throw new Error('repos.default_repo debe ser un repo dentro del workspace.', { cause })
  }
}
