/**
 * Detección y reconciliación de propiedades del board del cliente.
 *
 * La regla (una sola, en orden):
 *   1. MATCH primero: cada rol del pipeline se busca en el board por TIPO +
 *      PROPÓSITO (nombre en cualquier idioma), nunca por el nombre del default.
 *   2. Lo existente NO se toca: ni tipo, ni opciones, ni rename. Jamás.
 *   3. Se agrega SOLO lo imprescindible sin equivalente — y qué es imprescindible
 *      lo decide el workflow configurado, no una lista fija: con handoffs
 *      declarados (can_trigger), agente+hop pasan de opcionales a requeridas.
 */

export type NotionProp = {
  type?: string
  select?: { options: Array<{ name: string; color?: string }> }
  status?: {
    options: Array<{ id: string; name: string; color: string }>
    groups: Array<{ name: string; option_ids: string[] }>
  }
}
export type BoardProps = Record<string, NotionProp>

/** La API no deja escribirlas: nunca se mapean a un rol (el pipeline escribe los suyos). */
const READ_ONLY = new Set(['formula', 'rollup', 'created_by', 'created_time', 'last_edited_by', 'last_edited_time', 'unique_id', 'button'])

export type RoleKey =
  | 'repo_property' | 'pr_property' | 'agent_property' | 'hop_property'
  | 'model_property' | 'progress_property' | 'owner_property' | 'participants_property'
  | 'estimation_property'

const ROLES: Array<{ key: RoleKey; type: string; re: RegExp }> = [
  { key: 'repo_property', type: 'url', re: /repo|repositor/i },
  { key: 'pr_property', type: 'url', re: /^pr$|pull|merge request/i },
  { key: 'agent_property', type: 'select', re: /agente|agent\b/i },
  { key: 'hop_property', type: 'number', re: /hop|salto/i },
  { key: 'model_property', type: 'select', re: /modelo|model\b/i },
  { key: 'progress_property', type: 'number', re: /progreso|progress|avance/i },
  { key: 'estimation_property', type: 'select', re: /effort|esfuerzo|estimaci|size|talla|puntos|story ?points/i },
  { key: 'owner_property', type: 'people', re: /owner|dueñ|responsab|asignado|assignee/i },
  { key: 'participants_property', type: 'people', re: /involucrad|particip|watcher|equipo/i },
]

/** tipo Notion de cada rol — para listar candidatos cuando no hay match */
export const ROLE_TYPES = Object.fromEntries(ROLES.map(r => [r.key, r.type])) as Record<RoleKey, string>

export type Detected = {
  repo_property: string | null
  pr_property: string | null
  agent_property: string | null
  hop_property: string | null
  model_property: string | null
  progress_property: string | null
  estimation_property: string | null
  owner_property: string | null
  participants_property: string | null
  estimation_values: string[]
  agent_filter: { property: string; run_value?: string; skip_value?: string } | null
}

/**
 * Busca cada rol en el board. Un rol reclama una propiedad y nadie más la usa
 * (claim-once): dos roles compartiendo columna es siempre un error de mapeo.
 * Lo que no aparece queda en null — el que decide si eso es un problema es
 * requiredRoleKeys(), no esta función.
 */
export function detectProps(props: BoardProps): Detected {
  const claimed = new Set<string>()
  const find = (type: string, re: RegExp): string | null => {
    const hit = Object.entries(props).find(([name, p]) =>
      p.type === type && !READ_ONLY.has(p.type ?? '') && !claimed.has(name) && re.test(name))
    if (!hit) return null
    claimed.add(hit[0])
    return hit[0]
  }

  // agent_filter primero: es un select y no debe quedar reclamado por agente/modelo
  let agent_filter: Detected['agent_filter'] = null
  for (const [name, p] of Object.entries(props)) {
    if (p.type !== 'select') continue
    if (!/ejecutor|executor|ejecuta|owner type|agent type|tipo de tarea/i.test(name)) continue
    // Opt-in primero: con una opción "Agente" el gate correcto es "corre SOLO si
    // dice esto". El opt-out queda para boards que no tienen esa opción.
    const agente = p.select?.options.find(o => /agente|agent\b|bot\b|\bia\b|\bai\b/i.test(o.name))
    const human = p.select?.options.find(o => /humano|human|persona|manual/i.test(o.name))
    if (agente) { agent_filter = { property: name, run_value: agente.name }; claimed.add(name); break }
    if (human) { agent_filter = { property: name, skip_value: human.name }; claimed.add(name); break }
  }

  const out = Object.fromEntries(ROLES.map(r => [r.key, find(r.type, r.re)])) as Omit<Detected, 'agent_filter'>
  // los valores del board mandan: el agente debe escribir "🟢 S", no "S"
  const est = out.estimation_property
  const estimation_values = est ? (props[est]?.select?.options ?? []).map(o => o.name) : []
  return { ...out, estimation_values, agent_filter }
}

/**
 * Qué roles vuelve imprescindibles ESTE workflow. Sin Repo nada corre; el PR lo
 * escribe cualquier fase dev; agente+hop solo si hay handoffs declarados —
 * sin ellos el server los desactiva en silencio y el flujo configurado miente.
 */
export function requiredRoleKeys(cfg: { agents?: Record<string, { can_trigger?: string[] }> }): Set<RoleKey> {
  const req = new Set<RoleKey>(['repo_property', 'pr_property'])
  const handoffs = Object.values(cfg.agents ?? {}).some(a => (a.can_trigger ?? []).length > 0)
  if (handoffs) {
    req.add('agent_property')
    req.add('hop_property')
  }
  return req
}

type PropShape = Record<string, unknown>

/** Forma de creación de cada rol, con el nombre que la config le da. */
export function propShape(key: RoleKey | 'agent_filter', cfg: {
  agent_filter?: { property: string; run_value?: string; skip_value?: string } | null
  agents?: Record<string, unknown>
}): PropShape {
  if (key === 'agent_filter') {
    return { type: 'select', select: { options: [
      { name: cfg.agent_filter?.run_value ?? 'Agente', color: 'purple' },
      { name: cfg.agent_filter?.skip_value ?? 'Humano', color: 'blue' },
    ] } }
  }
  if (key === 'repo_property' || key === 'pr_property') return { type: 'url', url: {} }
  if (key === 'agent_property') {
    const options = Object.keys(cfg.agents ?? {}).map((name, i) =>
      ({ name, color: ['blue', 'purple', 'orange', 'green', 'pink'][i % 5] }))
    return { type: 'select', select: { options } }
  }
  if (key === 'hop_property' || key === 'progress_property') return { type: 'number', number: { format: 'number' } }
  if (key === 'model_property') {
    return { type: 'select', select: { options: [
      { name: 'haiku', color: 'green' }, { name: 'sonnet', color: 'blue' },
      { name: 'opus', color: 'purple' }, { name: 'fable', color: 'orange' },
    ] } }
  }
  return { type: 'people', people: {} }
}

export type Hole = { role: RoleKey | 'agent_filter'; name: string; shape: PropShape }

/**
 * Los huecos REALES de un board existente: roles imprescindibles para esta config
 * que no mapean a ninguna propiedad. Devuelve qué habría que crear; crearlo o no
 * es una decisión del operador (el wizard pregunta), nunca automática.
 */
export function missingRequired(
  cfg: {
    repo_property?: string; pr_property?: string
    agent_property?: string | null; hop_property?: string | null
    agent_filter?: { property: string; run_value?: string; skip_value?: string } | null
    agents?: Record<string, { can_trigger?: string[] }>
  },
  props: BoardProps,
): Hole[] {
  const holes: Hole[] = []
  const wanted: Array<[RoleKey | 'agent_filter', string | null | undefined]> = [
    ['repo_property', cfg.repo_property],
    ['pr_property', cfg.pr_property],
    ['agent_property', cfg.agent_property],
    ['hop_property', cfg.hop_property],
    ['agent_filter', cfg.agent_filter?.property],
  ]
  const required = requiredRoleKeys(cfg)

  for (const [role, name] of wanted) {
    const isRequired = role === 'agent_filter' ? Boolean(cfg.agent_filter) : required.has(role)
    if (!isRequired || !name) continue
    if (props[name]) continue // existe: se usa tal cual, compatible o no lo dirá checkMappings
    holes.push({ role, name, shape: propShape(role, cfg) })
  }
  return holes
}

export type MappingIssue = { key: string; name: string; problem: 'ausente' | 'tipo' | 'solo-lectura'; found?: string }

/**
 * Salud de los mapeos de una config contra el board actual (modo doctor):
 * cada *_property configurada debe existir con un tipo escribible y compatible.
 */
export function checkMappings(
  cfg: Record<string, unknown> & { agent_filter?: { property: string } | null },
  props: BoardProps,
): MappingIssue[] {
  const expect: Array<[string, string | null | undefined, string]> = [
    ...ROLES.map(r => [r.key, cfg[r.key] as string | null | undefined, r.type] as [string, string | null | undefined, string]),
    ['agent_filter.property', cfg.agent_filter?.property, 'select'],
    ['status_property', cfg.status_property as string, 'status'],
  ]
  const issues: MappingIssue[] = []
  // el doc de proyecto admite dos tipos, así que no entra en la tabla de arriba
  const docName = cfg.project_doc_property as string | undefined
  if (docName) {
    const dp = props[docName]
    if (!dp) issues.push({ key: 'project_doc_property', name: docName, problem: 'ausente' })
    else if (!['relation', 'url'].includes(dp.type ?? '')) {
      issues.push({ key: 'project_doc_property', name: docName, problem: 'tipo', found: dp.type })
    }
  }
  for (const [key, name, type] of expect) {
    if (!name) continue
    const p = props[name]
    if (!p) { issues.push({ key, name, problem: 'ausente' }); continue }
    if (READ_ONLY.has(p.type ?? '')) { issues.push({ key, name, problem: 'solo-lectura', found: p.type }); continue }
    if (p.type !== type) issues.push({ key, name, problem: 'tipo', found: p.type })
  }
  return issues
}
