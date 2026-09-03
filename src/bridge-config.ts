/**
 * Configuración del pipeline — a nivel INSTANCIA (el board es uno):
 *   <bridge>/workflow.json  — columnas, triggers → agent, handoffs, identidad de chat
 *   <bridge>/agents/*.md    — agents por DEFECTO (formato nativo de Claude Code)
 *
 * Los repos aportan su contexto nativo solos (CLAUDE.md, skills, .mcp.json — cwd
 * del claude lanzado) y pueden SOBRESCRIBIR un agent creando .claude/agents/<n>.md.
 * Validación al arrancar (zod en el borde): agents referenciados existen, targets
 * de movimiento existen, can_trigger sin ciclos.
 */
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import YAML from 'yaml'
import { BRIDGE_DIR } from './env.ts'

// ---------- esquema de .bridge/workflow.json ----------

const StateSchema = z.object({
  name: z.string().min(1),
  color: z.string().optional(),
  group: z.enum(['To-do', 'In progress', 'Complete']).optional(),
  /** nombre del agent de .claude/agents/ que corre al ENTRAR a esta columna */
  trigger: z.string().min(1).optional(),
  /** a dónde mueve el agente el card al terminar */
  agent_moves_to: z.string().min(1).optional(),
  /**
   * El agente trabaja y NO mueve el card: un humano decide el siguiente paso.
   * Para boards sin compuerta después de la fase. Explícito a propósito —
   * omitir `agent_moves_to` por olvido sigue siendo un error de config.
   * Con esto el comentario del agente pasa a ser obligatorio: es la única señal.
   */
  agent_stays: z.boolean().optional(),
  /** la fase corre en un git worktree aislado (rama agent/<id>) */
  use_worktree: z.boolean().optional(),
  gate: z.enum(['human']).optional(),
  terminal: z.boolean().optional(),
}).strict()

const AgentBridgeSchema = z.object({
  /** reglas de permiso que el launcher pasa a --allowed-tools (sintaxis del CLI de claude) */
  allowed_tools: z.array(z.string().min(1)).default([]),
  /** identidad visible en adaptadores de chat (Fase 3) */
  chat: z.object({
    username: z.string().min(1).optional(),
    emoji: z.string().min(1).optional(),
  }).optional(),
  /** a qué agents puede pasarle trabajo (handoffs; sin ciclos por construcción) */
  can_trigger: z.array(z.string().min(1)).default([]),
  /** activación adicional a la columna: menciones en comentarios y creación de cards */
  triggers: z.object({
    /** textos que activan al agent al aparecer en un comentario, p. ej. "@qa" */
    mentions: z.array(z.string().min(1)).default([]),
    /** el agent corre cuando se CREA un card en el board (rol triage) */
    page_created: z.boolean().default(false),
  }).strict().optional(),
}).strict()

const BridgeConfigSchema = z.object({
  /**
   * Nombre de ESTA instancia — como el equipo llama a su app ("Regent", "Acme", …).
   * Es la identidad del hub en todas partes: cómo firma en el chat, cómo se le
   * menciona en la ayuda, el banner del server. `pnpm setup` lo pregunta.
   */
  name: z.string().min(1).default('Regent'),
  status_property: z.string().default('Status'),
  /**
   * Quién ejecuta el card. `run_value` es OPT-IN: solo corre el agente si la
   * propiedad vale exactamente eso — un card sin el valor NUNCA se ejecuta.
   * Es lo correcto en un board compartido, donde la mayoría de los cards son
   * trabajo humano y no tienen la propiedad puesta. `skip_value` es el opt-out
   * histórico (corre salvo que diga eso); sirve en boards que existen solo para
   * agentes. Si están los dos, manda run_value.
   */
  agent_filter: z.object({
    property: z.string().min(1),
    run_value: z.string().min(1).optional(),
    skip_value: z.string().min(1).optional(),
  }).refine(f => f.run_value || f.skip_value, {
    message: 'agent_filter necesita run_value (opt-in, recomendado) o skip_value (opt-out)',
  }).nullish(),
  max_hops: z.number().int().min(1).max(10).default(3),
  /** si está definido: al detectar el PR del card mergeado (polling con gh), mover el card aquí */
  pr_merged_moves_to: z.string().min(1).optional(),
  /** propiedad del card que pone el link del PR (la escribe el dev) */
  pr_property: z.string().default('PR'),
  /**
   * Repo raíz del workspace (nombre de carpeta bajo REPO_PATH). Con esto el
   * agente corre SIEMPRE ahí — contexto completo, todos los repos legibles — y
   * abre un worktree por cada repo que decide cambiar (`regent-wt`). La
   * propiedad Repo del card pasa a ser opcional. Sin esto, el card necesita Repo
   * y el agente corre en el worktree de ese único repo (caso simple).
   */
  workspace_root: z.string().min(1).nullable().default(null),
  /**
   * .env que se inyectan al proceso de cada agente (los `${VARS}` del .mcp.json
   * del repo resuelven de acá). Rutas explícitas, `~` permitido; el último gana y
   * todos ganan sobre el entorno del server — como `set -a; source .env`.
   * Quien spawnea a claude (herdr, tmux) no hereda el entorno de regent.
   */
  agent_env_files: z.array(z.string().min(1)).default([]),
  /**
   * Permisos de los agentes lanzados. `allowlist` = solo `allowed_tools`; lo demás
   * pide confirmación en la terminal — y un agente desatendido se queda esperando.
   * `bypass` = sin confirmaciones (`--permission-mode bypassPermissions`): lo que
   * el rol NO debe hacer se dice en su prompt, no en la lista.
   */
  agent_permissions: z.enum(['allowlist', 'bypass']).default('allowlist'),
  /** propiedad url del card que apunta al repo de GitHub (elige el clon en REPO_PATH) */
  repo_property: z.string().default('Repo'),
  /**
   * Rama base por repo (nombre del repo → rama). Gana sobre todo lo demás.
   * Sin entrada acá: `develop` si existe en el remoto, si no el default del repo.
   * Explícito para el repo que se salga de la convención del equipo.
   */
  repo_base_branches: z.record(z.string(), z.string().min(1)).default({}),
  /** rama a preferir como base cuando el repo la tiene; null = usar siempre el default del repo */
  default_base_branch: z.string().min(1).nullable().default('develop'),
  /** propiedad select donde el launcher deja qué agent corre (fuente de verdad del handoff); null = board sin ella */
  agent_property: z.string().min(1).nullable().default('Agente'),
  /** propiedad number con el contador de saltos del handoff; null = board sin ella (hops siempre 0) */
  hop_property: z.string().min(1).nullable().default('Hop'),
  /** propiedad del card que sobrescribe el modelo del agent; null = solo frontmatter/default del CLI */
  model_property: z.string().min(1).nullable().default('Modelo'),
  /**
   * Propiedad donde el pm deja el tamaño. El nombre y los valores salen del board
   * del cliente (acá "Effort" con opciones "🟢 S"…), no de un default: escribir
   * "S" en una propiedad cuyas opciones son "🟢 S" falla en silencio.
   */
  estimation_property: z.string().min(1).nullable().default(null),
  /** valores admitidos por estimation_property, en orden de menor a mayor */
  estimation_values: z.array(z.string().min(1)).default([]),
  /** propiedad de avance que escriben los agentes — el intake no la llena; null = board sin ella */
  progress_property: z.string().min(1).nullable().default('Progreso'),
  /** propiedad people del dueño humano; null = usar la primera people libre del board */
  owner_property: z.string().min(1).nullable().default('Owner'),
  /** propiedad people donde poner a los involucrados del hilo de origen del chat (opcional) */
  participants_property: z.string().min(1).optional(),
  /** propiedad del card que enlaza al DOC DE PROYECTO en Notion (relation o url); su contenido se inyecta al prompt */
  project_doc_property: z.string().min(1).optional(),
  // nota: los defaults de estos bloques van COMPLETOS — z.default({}) devuelve el
  // literal sin aplicar los defaults internos. Un objeto parcial sí los recibe.
  /** sala de chat por card */
  chat: z.object({
    /** user ids invitados a toda sala; vacío = auto-descubrir los humanos del workspace */
    invite_users: z.array(z.string().min(1)).default([]),
    /** tope del auto-descubrimiento (0 = desactivado; workspaces grandes: usa invite_users) */
    auto_invite_limit: z.number().int().min(0).default(15),
  }).strict().default({ invite_users: [], auto_invite_limit: 15 }),
  /** el "secretario": interpreta las menciones del chat antes de crear/actualizar el card */
  intake: z.object({
    model: z.string().min(1).default('sonnet'),
    timeout_sec: z.number().int().min(10).default(90),
    /**
     * Columna donde cae un card creado desde el chat. Sin esto se usaba la
     * primera del board, que en un board de cliente puede ser cualquier cosa
     * ("Despriorizado" no es donde nace una tarea). null = primera columna.
     */
    landing_status: z.string().min(1).nullable().default(null),
  }).strict().default({ model: 'sonnet', timeout_sec: 90, landing_status: null }),
  github: z.object({
    /** repos a escuchar con `gh webhook forward` — lista owner/repo, o "auto" = los que el board trabaja */
    forward_repos: z.union([z.literal('auto'), z.array(z.string().min(1))]).default([]),
  }).strict().default({ forward_repos: [] }),
  states: z.array(StateSchema).min(1),
  agents: z.record(z.string(), AgentBridgeSchema).default({}),
}).strict()

export type BridgeState = z.infer<typeof StateSchema>
export type BridgeConfig = z.infer<typeof BridgeConfigSchema>

// ---------- migración de .env → workflow.json ----------

/**
 * Regla de la frontera: `.env` guarda SECRETOS y lo que cambia por MÁQUINA
 * (tokens, ids del board, REPO_PATH, PORT, TERMINAL_BACKEND). Todo lo que
 * describe el BOARD o el COMPORTAMIENTO vive en workflow.json, que es la config
 * que el equipo edita y versiona.
 *
 * Estas claves cruzaron esa frontera. La env sigue ganando (escape hatch del
 * operador) pero se avisa al arrancar para que la instancia se limpie.
 */
const MOVED_ENV: Record<string, string> = {
  SLACK_INVITE_USERS: 'chat.invite_users',
  INTAKE_MODEL: 'intake.model',
  INTAKE_TIMEOUT_SEC: 'intake.timeout_sec',
  GITHUB_FORWARD_REPOS: 'github.forward_repos',
}

/** claves que ya no hacen nada (el equipo elige sus repos sin allowlist) */
const DEAD_ENV = ['ALLOWED_REPO_OWNERS', 'PROJECTS_DIR', 'DEFAULT_REPO']

export function warnMovedEnv(): void {
  for (const [key, dest] of Object.entries(MOVED_ENV)) {
    if (process.env[key]) console.warn(`[config] ${key} está en .env → su lugar es workflow.json → ${dest} (por ahora la env gana)`)
  }
  for (const key of DEAD_ENV) {
    if (process.env[key]) console.warn(`[config] ${key} ya no se usa — puedes borrarla de .env`)
  }
}

/**
 * Valor de env (csv) si trae algo, si no el de la config. Una env VACÍA cuenta
 * como ausente: `SLACK_INVITE_USERS=""` no debe anular chat.invite_users.
 */
export function csvEnvOr(key: string, fallback: string[]): string[] {
  const items = (process.env[key] ?? '').split(',').map(s => s.trim()).filter(Boolean)
  return items.length ? items : fallback
}

// ---------- agents nativos (.claude/agents/*.md) ----------

export interface NativeAgent {
  name: string
  description: string
  /** tool names del frontmatter nativo (informativo; los permisos de launch salen de .bridge) */
  tools?: string
  model?: string
  /** cuerpo markdown = prompt del rol */
  body: string
  filePath: string
}

export function parseAgentFile(filePath: string): NativeAgent {
  const raw = fs.readFileSync(filePath, 'utf8')
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) throw new Error(`${filePath}: sin frontmatter YAML (--- ... ---)`)
  const fm = YAML.parse(m[1]) ?? {}
  if (!fm.name || typeof fm.name !== 'string') throw new Error(`${filePath}: frontmatter sin "name"`)
  return {
    name: fm.name,
    description: typeof fm.description === 'string' ? fm.description : '',
    tools: typeof fm.tools === 'string' ? fm.tools : undefined,
    model: typeof fm.model === 'string' ? fm.model : undefined,
    body: m[2].trim(),
    filePath,
  }
}

export function loadAgentsDir(dir: string): Map<string, NativeAgent> {
  const agents = new Map<string, NativeAgent>()
  if (!fs.existsSync(dir)) return agents
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
    const agent = parseAgentFile(path.join(dir, f))
    agents.set(agent.name, agent)
  }
  return agents
}

// ---------- carga + validación cruzada ----------

export interface LoadedBridge {
  config: BridgeConfig
  /** agents por defecto (del bridge); un repo puede sobrescribir con .claude/agents/<n>.md */
  agents: Map<string, NativeAgent>
  configDir: string
  stateByName: Record<string, BridgeState>
  triggerStates: BridgeState[]
}

/** configDir: por defecto el dir del bridge; BRIDGE_CONFIG_DIR lo sobrescribe (tests). */
export function loadBridge(configDir: string = process.env.BRIDGE_CONFIG_DIR ?? BRIDGE_DIR): LoadedBridge {
  const cfgPath = path.join(configDir, 'config', 'workflow.json')
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`falta ${cfgPath} — config/ es TU instancia; genérala con \`pnpm setup\``)
  }
  const parsed = BridgeConfigSchema.safeParse(JSON.parse(fs.readFileSync(cfgPath, 'utf8')))
  if (!parsed.success) {
    throw new Error(`.bridge/workflow.json inválido:\n${parsed.error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`)
  }
  const config = parsed.data
  const agents = loadAgentsDir(path.join(configDir, 'agents'))

  const names = config.states.map(s => s.name)
  const dupes = names.filter((n, i) => names.indexOf(n) !== i)
  if (dupes.length) throw new Error(`estados duplicados en workflow.json: ${dupes.join(', ')}`)
  const stateByName = Object.fromEntries(config.states.map(s => [s.name, s]))

  const errors: string[] = []
  for (const s of config.states) {
    if (s.trigger && !agents.has(s.trigger)) {
      errors.push(`estado "${s.name}": trigger apunta al agent "${s.trigger}" pero no existe agents/${s.trigger}.md`)
    }
    if (s.agent_moves_to && !stateByName[s.agent_moves_to]) {
      errors.push(`estado "${s.name}": agent_moves_to apunta a "${s.agent_moves_to}" que no es un estado`)
    }
    if (s.agent_stays && s.agent_moves_to) {
      errors.push(`estado "${s.name}": agent_stays y agent_moves_to son excluyentes — o se queda, o se mueve`)
    }
    if (s.agent_stays && !s.trigger) {
      errors.push(`estado "${s.name}": agent_stays sin trigger no significa nada (ningún agente corre acá)`)
    }
    if (s.trigger && !s.agent_moves_to && !s.agent_stays) {
      errors.push(`estado "${s.name}": tiene trigger pero no agent_moves_to (si el card debe quedarse, pon "agent_stays": true)`)
    }
  }
  if (config.intake.landing_status && !stateByName[config.intake.landing_status]) {
    errors.push(`intake.landing_status apunta a "${config.intake.landing_status}" que no es un estado`)
  }
  if (config.pr_merged_moves_to && !stateByName[config.pr_merged_moves_to]) {
    errors.push(`pr_merged_moves_to apunta a "${config.pr_merged_moves_to}" que no es un estado`)
  }
  for (const [name, a] of Object.entries(config.agents)) {
    if (!agents.has(name)) errors.push(`workflow agents."${name}" no existe en agents/`)
    for (const t of a.can_trigger) {
      if (!agents.has(t)) errors.push(`agents."${name}".can_trigger: "${t}" no existe en agents/`)
    }
  }
  // ciclos en can_trigger (DFS)
  const visiting = new Set<string>(), done = new Set<string>()
  const visit = (n: string, chain: string[]): void => {
    if (done.has(n)) return
    if (visiting.has(n)) {
      errors.push(`ciclo en can_trigger: ${[...chain, n].join(' → ')}`)
      return
    }
    visiting.add(n)
    for (const t of config.agents[n]?.can_trigger ?? []) visit(t, [...chain, n])
    visiting.delete(n)
    done.add(n)
  }
  for (const n of Object.keys(config.agents)) visit(n, [])

  if (errors.length) throw new Error(`validación de .bridge/workflow.json falló:\n${errors.map(e => `  - ${e}`).join('\n')}`)

  return {
    config,
    agents,
    configDir,
    stateByName,
    triggerStates: config.states.filter(s => s.trigger),
  }
}
