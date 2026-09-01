#!/usr/bin/env node
/**
 * pnpm setup — wizard interactivo: detecta el entorno, pregunta lo mínimo (Enter = default)
 * y ESCRIBE la configuración (.env, workflow.json, process.md). Re-ejecutable como doctor.
 *
 * Los kanban son variables: si ya tienes un board, el wizard LO LEE y deriva el workflow
 * de TUS columnas (solo pregunta cuáles disparan agentes). Si no, crea uno con el default.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import readline from 'node:readline/promises'
import { BRIDGE_DIR } from './env.ts'
import { detectProps, missingRequired, checkMappings, requiredRoleKeys, ROLE_TYPES, type BoardProps } from './board-detect.ts'
import { slackApi, createAppFromManifest, brandManifest, installUrl, appTokenUrl, exportManifest, updateManifest, manifestChanges, needsReinstall } from './slack-admin.ts'

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const ask = async (q: string, def?: string): Promise<string> => {
  const a = (await rl.question(def !== undefined ? `${q} [${def}]: ` : `${q}: `)).trim()
  return a || def || ''
}
const ok = (s: string) => console.log(`  ✓ ${s}`)
const warn = (s: string) => console.log(`  ⚠ ${s}`)
const has = (cmd: string, args: string[] = ['--version']): boolean => {
  try { execFileSync(cmd, args, { stdio: 'ignore' }); return true } catch { return false }
}

console.log('\n═══ regent · setup ═══\n')

// ---- 1. entorno ----
console.log('Entorno:')
const nodeMajor = Number(process.versions.node.split('.')[0])
nodeMajor >= 22 ? ok(`node ${process.versions.node}`) : warn(`node ${process.versions.node} — se requiere ≥22`)
has('claude') ? ok('claude CLI') : warn('claude CLI no encontrado — npm i -g @anthropic-ai/claude-code')
has('gh', ['auth', 'status']) ? ok('gh autenticado') : warn('gh no autenticado — `gh auth login`')
if (has('gh', ['webhook', '--help'])) ok('gh webhook forward disponible (merges por evento, sin URL pública)')
else console.log('  ℹ opcional: `gh extension install cli/gh-webhook` para recibir merges al instante')
if (has('herdr', ['tab', 'list'])) ok('herdr (tabs interactivos)')
else if (has('tmux', ['-V'])) ok('tmux (attach por SSH)')
else warn('sin herdr/tmux — agentes headless (solo logs)')

// ---- 2. .env ----
console.log('\nConfiguración:')
const envPath = path.join(BRIDGE_DIR, '.env')
const env: Record<string, string> = {}
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*["']?([^"']*)["']?\s*$/)
    if (m) env[m[1]] = m[2]
  }
}
if (env.NOTION_TOKEN) ok('NOTION_TOKEN presente')
else {
  console.log('  Integración interna: https://app.notion.com/developers/connections')
  console.log('  (Read/Update/Insert content + comments + user info sin emails)')
  env.NOTION_TOKEN = await ask('  Secret (ntn_…)')
}
env.REPO_PATH = await ask('  Carpeta con tus repos clonados', env.REPO_PATH || path.join(os.homedir(), 'Projects'))
env.PORT = env.PORT || '8787'

// ---- 3. board + workflow ----
const wfPath = path.join(BRIDGE_DIR, 'config', 'workflow.json')
const wfExists = fs.existsSync(wfPath)
console.log('\nBoard y workflow:')
if (wfExists && env.DATABASE_ID) {
  ok('workflow.json y board ya configurados — verifico que sigan en sync (borra workflow.json para re-derivar de cero)')
  await reconcileBoard()
} else {
  // Si .env ya nombra un board (p. ej. falta solo config/), ese es el default:
  // preguntar de cero cuando el dato ya está invita a pegar otro por error.
  const boardRef = env.DATABASE_ID
    ? await ask(`  Board del .env — Enter para usarlo, o pega otra URL/ID`, env.DATABASE_ID)
    : await ask('  ¿Ya tienes un board? Pega su URL o ID (vacío = crear uno default)')
  if (boardRef && env.NOTION_TOKEN) {
    await adoptBoard(boardRef)
  } else if (!wfExists) {
    writeDefaultWorkflow()
    console.log('  Para crear el board desde este workflow: comparte una página con la conexión y corre')
    console.log('  node src/setup-board.ts --parent <page_id>  (luego pega los IDs que imprime en .env)')
  }
}

/**
 * Trae el database traduciendo los dos fallos típicos del primer setup: el token
 * es válido pero la integración no tiene el board compartido (404), o el token
 * está mal (401). Notion no da acceso a nada por defecto: compartir es un paso
 * manual en la UI, y sin este mensaje el wizard moría con un stack trace.
 */
async function retrieveBoard(
  notion: { databases: { retrieve: (a: { database_id: string }) => Promise<unknown> } },
  dbId: string,
): Promise<{ id: string; data_sources?: Array<{ id: string }> } | null> {
  try {
    return await notion.databases.retrieve({ database_id: dbId }) as { id: string; data_sources?: Array<{ id: string }> }
  } catch (err) {
    const e = err as { code?: string; message?: string }
    if (e.code === 'object_not_found') {
      const who = e.message?.match(/integration "([^"]+)"/)?.[1] ?? 'tu integración'
      warn(`la integración ${who} no tiene acceso a ese board (o el ID es de otro board)`)
      console.log(`    En Notion, abre el board → ··· → Connections → agrega "${who}".`)
      console.log('    Compartir es un paso manual: una integración no ve nada hasta que se lo das.')
    } else if (e.code === 'unauthorized') {
      warn('NOTION_TOKEN inválido o revocado — genera uno nuevo en la integración y ponlo en .env')
    } else {
      warn(`Notion respondió ${e.code ?? 'error'}: ${e.message ?? String(err)}`)
    }
    return null
  }
}

/** Lee el board del usuario y deriva workflow.json de SUS columnas. */
async function adoptBoard(ref: string): Promise<void> {
  const { Client } = await import('@notionhq/client')
  const notion = new Client({ auth: env.NOTION_TOKEN })
  const dbId = ref.match(/[0-9a-f]{32}/i)?.[0] ?? ref
  const db = await retrieveBoard(notion, dbId)
  if (!db) return
  const dsId = db.data_sources?.[0]?.id
  if (!dsId) return warn('no encontré data source en ese database')
  const ds = await notion.dataSources.retrieve({ data_source_id: dsId }) as {
    properties: Record<string, { type?: string; status?: { options: Array<{ id: string; name: string; color: string }>; groups: Array<{ name: string; option_ids: string[] }> } }>
  }
  const statusEntry = Object.entries(ds.properties).find(([, p]) => p.type === 'status')
  if (!statusEntry) return warn('el board no tiene propiedad de tipo status')
  const [statusProp, prop] = statusEntry
  const options = prop.status!.options
  const groupOf: Record<string, string> = {}
  for (const g of prop.status!.groups) for (const oid of g.option_ids) groupOf[oid] = g.name
  ok(`board leído: propiedad "${statusProp}" con ${options.length} columnas`)
  options.forEach((o, i) => console.log(`    ${i + 1}. ${o.name} (${groupOf[o.id] ?? '?'})`))

  const pick = async (q: string, guessRe: RegExp, allowNone = false): Promise<number> => {
    const guess = options.findIndex(o => guessRe.test(o.name))
    const def = guess >= 0 ? String(guess + 1) : (allowNone ? '0' : '1')
    const a = await ask(`  ${q}${allowNone ? ' (0 = ninguna)' : ''}`, def)
    return Number(a) - 1
  }
  // 0 = el card se queda donde está y el agente avisa por comentario: hay boards
  // sin compuerta después de una fase, y forzar un destino inventa una columna.
  const moveTo = async (label: string, re: RegExp): Promise<number> =>
    pick(`  → ¿a qué columna mueve el card al terminar? (0 = se queda donde está, avisa por comentario)${label}`, re, true)
  const iPlan = await pick('¿Qué columna dispara al PM (planificar)?', /plan/i, true)
  const iPlanTo = iPlan >= 0 ? await moveTo('', /review|revis/i) : -1
  const iImpl = await pick('¿Qué columna dispara al DEV (codear)?', /progress|desarrollo|develop|doing|impl|curso/i, true)
  const iImplTo = iImpl >= 0 ? await moveTo('', /test|qa|review/i) : -1

  const states = options.map((o, i) => {
    const s: Record<string, unknown> = { name: o.name, color: o.color, group: normalizeGroup(groupOf[o.id]) }
    if (i === iPlan) { s.trigger = 'pm'; if (iPlanTo >= 0) s.agent_moves_to = options[iPlanTo]?.name; else s.agent_stays = true }
    if (i === iImpl) { s.trigger = 'dev'; if (iImplTo >= 0) s.agent_moves_to = options[iImplTo]?.name; else s.agent_stays = true; s.use_worktree = true }
    if (normalizeGroup(groupOf[o.id]) === 'Complete') s.terminal = true
    return s
  })
  const terminals = states.filter(s => s.terminal).map(s => s.name as string)
  const mergedDef = terminals.find(t => /done|complet|listo|termin/i.test(t)) ?? terminals[0] ?? ''
  const mergedTo = await ask('  ¿A qué columna va un card cuando su PR se mergea? (vacío = off)', mergedDef)
  const docProp = await ask('  ¿Propiedad que enlaza al doc de proyecto? (vacío = sin doc)', 'Proyecto Doc')

  const appName = await ask('  ¿Cómo se llama tu app? (así firma en el chat y así la mencionas)', 'Regent')
  const agents = defaultAgents()
  const detected = detectProps(ds.properties as BoardProps)

  // Roles imprescindibles sin equivalente en el board: reciben el nombre default
  // y se OFRECE crearlos. Lo existente jamás se toca.
  const used = new Set<string>()
  for (const v of Object.values(detected)) {
    if (typeof v === 'string' && v) used.add(v)
    else if (v && typeof v === 'object') used.add(v.property)
  }
  const boardProps = ds.properties as BoardProps
  const resolved = { ...detected }
  resolved.repo_property = detected.repo_property ?? await pickProp(boardProps, used, 'repo_property (URL del repo del card)', 'url', 'Repo')
  resolved.pr_property = detected.pr_property ?? await pickProp(boardProps, used, 'pr_property (URL del PR)', 'url', 'PR')
  resolved.agent_property = detected.agent_property ?? await pickProp(boardProps, used, 'agent_property (qué agent corre el card)', 'select', 'Agente')
  resolved.hop_property = detected.hop_property ?? await pickProp(boardProps, used, 'hop_property (contador de handoffs)', 'number', 'Hop')
  resolved.agent_filter = detected.agent_filter ?? await pickFilter(boardProps, used)
  for (const [role, name] of Object.entries(resolved)) {
    if (typeof name === 'string' && name) ok(`${role} → "${name}"${boardProps[name] ? ' (del board)' : ' (a crear)'}`)
    else if (name && typeof name === 'object') ok(`agent_filter → "${name.property}" (skip: ${name.skip_value})${boardProps[name.property] ? ' (del board)' : ' (a crear)'}`)
  }
  const holes = missingRequired({ ...resolved, agents }, ds.properties as BoardProps)
  if (holes.length) {
    console.log(`  Sin equivalente en el board (imprescindibles para este workflow): ${holes.map(h => h.name).join(', ')}`)
    const go = await ask('  ¿Las agrego al board? (solo agrega — lo existente no se toca) S/n', 'S')
    if (/^\s*[sy]/i.test(go) || go === '') {
      await notion.dataSources.update({
        data_source_id: dsId,
        properties: Object.fromEntries(holes.map(h => [h.name, h.shape])) as never,
      })
      ok(`agregadas: ${holes.map(h => h.name).join(', ')}`)
    } else {
      for (const h of holes) {
        if (h.role === 'agent_property') resolved.agent_property = null
        if (h.role === 'hop_property') resolved.hop_property = null
        if (h.role === 'agent_filter') resolved.agent_filter = null
      }
      warn('sin agente+hop los handoffs declarados quedan desactivados; sin filtro ejecutor, TODO card en columna con trigger dispara agente')
    }
  }

  const { participants_property, ...roleProps } = resolved
  const wf = {
    name: appName,
    status_property: statusProp,
    ...roleProps,
    ...(participants_property ? { participants_property } : {}),
    max_hops: 3,
    ...(mergedTo ? { pr_merged_moves_to: mergedTo } : {}),
    ...(docProp ? { project_doc_property: docProp } : {}),
    ...defaultBehavior(),
    states,
    agents,
  }
  fs.mkdirSync(path.dirname(wfPath), { recursive: true })
  fs.writeFileSync(wfPath, JSON.stringify(wf, null, 2) + '\n')
  env.DATABASE_ID = db.id.replace(/-/g, '')
  env.DATA_SOURCE_ID = dsId
  ok('workflow.json derivado de TU board (edítalo cuando quieras) + IDs al .env')
}

/**
 * Modo update/doctor: el board del cliente manda. Verifica que los mapeos y los
 * estados de workflow.json sigan reflejando el board real; adopta columnas nuevas,
 * marca las eliminadas y re-matchea propiedades rotas. Del board solo puede
 * AGREGAR huecos imprescindibles (preguntando) — jamás modifica lo existente.
 */
async function reconcileBoard(): Promise<void> {
  if (!env.NOTION_TOKEN) return warn('sin NOTION_TOKEN no puedo verificar el board')
  const { Client } = await import('@notionhq/client')
  const notion = new Client({ auth: env.NOTION_TOKEN })

  let dsId = env.DATA_SOURCE_ID
  if (!dsId) {
    const db = await notion.databases.retrieve({ database_id: env.DATABASE_ID }) as { data_sources?: Array<{ id: string }> }
    dsId = db.data_sources?.[0]?.id ?? ''
    if (dsId) env.DATA_SOURCE_ID = dsId
  }
  if (!dsId) return warn('no encontré el data source del board')
  const ds = await notion.dataSources.retrieve({ data_source_id: dsId }) as { properties: BoardProps }
  const props = ds.properties

  const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8')) as Record<string, unknown> & {
    status_property: string
    agent_filter?: { property: string; skip_value: string } | null
    pr_merged_moves_to?: string
    states: Array<Record<string, unknown> & { name: string; trigger?: string; gate?: string; agent_moves_to?: string }>
    agents?: Record<string, { can_trigger?: string[] }>
  }
  let dirty = false

  // 1. mapeos: cada propiedad configurada debe seguir en el board, escribible y del tipo esperado.
  //    Un mapeo sano nunca se re-matchea (estabilidad); uno roto intenta re-match por tipo+propósito.
  const issues = checkMappings(wf, props)
  if (issues.length) {
    const fresh = detectProps(props)
    const inUse = new Set(Object.values(wf).filter((v): v is string => typeof v === 'string'))
    for (const issue of issues) {
      const detail = issue.problem === 'ausente' ? 'ya no está en el board' : `es ${issue.found} (${issue.problem})`
      warn(`${issue.key} → "${issue.name}" ${detail}`)
      if (issue.key === 'status_property') { warn('  sin propiedad Status no hay pipeline — eso se resuelve en Notion, no acá'); continue }
      const roleKey = issue.key === 'agent_filter.property' ? 'agent_filter' : issue.key as keyof typeof fresh
      const alt = roleKey === 'agent_filter' ? fresh.agent_filter?.property : fresh[roleKey as Exclude<keyof typeof fresh, 'agent_filter'>]
      if (alt && !inUse.has(alt)) {
        console.log(`    → re-mapeado a "${alt}" (match por tipo+propósito)`)
        if (roleKey === 'agent_filter') wf.agent_filter = fresh.agent_filter
        else (wf as Record<string, unknown>)[roleKey] = alt
      } else {
        const req = requiredRoleKeys(wf)
        const isReq = roleKey === 'agent_filter' ? Boolean(wf.agent_filter) : req.has(roleKey as never)
        if (isReq) {
          // requerido: elegir de candidatos o re-crear con el nombre viejo (el paso de huecos la ofrece)
          if (roleKey === 'agent_filter') wf.agent_filter = await pickFilter(props, inUse)
          else (wf as Record<string, unknown>)[roleKey] = await pickProp(props, inUse, roleKey as string, ROLE_TYPES[roleKey as keyof typeof ROLE_TYPES], issue.name)
        } else {
          console.log('    → queda sin propiedad (null); el pipeline sigue sin esa capacidad')
          if (roleKey === 'agent_filter') wf.agent_filter = null
          else (wf as Record<string, unknown>)[roleKey] = null
        }
      }
      dirty = true
    }
  } else ok('mapeos de propiedades en orden')

  // 2. estados: el SET viene del board; el comportamiento (trigger/gate/moves) viaja por nombre
  const statusDef = props[wf.status_property]?.status
  if (statusDef) {
    const groupOf: Record<string, string> = {}
    for (const g of statusDef.groups) for (const oid of g.option_ids) groupOf[oid] = g.name
    const byName = Object.fromEntries(wf.states.map(st => [st.name, st]))
    const newStates = statusDef.options.map(o => {
      const grp = normalizeGroup(groupOf[o.id])
      const prev = byName[o.name]
      if (prev) return { ...prev, color: o.color, ...(grp ? { group: grp } : {}) }
      return { name: o.name, color: o.color, ...(grp ? { group: grp } : {}), ...(grp === 'Complete' ? { terminal: true } : {}) }
    })
    const removed = wf.states.filter(st => !statusDef.options.some(o => o.name === st.name))
    const added = newStates.filter(st => !byName[st.name])
    for (const st of removed) {
      const lost = st.trigger ? ` — ¡tenía trigger ${st.trigger}!` : st.gate ? ' — era compuerta humana' : ''
      warn(`columna eliminada del board: "${st.name}"${lost}`)
    }
    for (const st of added) console.log(`  + columna nueva adoptada: "${st.name}" (humana; asigna trigger/gate en workflow.json si corresponde)`)
    if (JSON.stringify(newStates) !== JSON.stringify(wf.states)) { wf.states = newStates; dirty = true }
    else ok('estados en sync con el board')

    const names = new Set(newStates.map(st => st.name))
    for (const st of newStates) {
      if (st.agent_moves_to && !names.has(st.agent_moves_to as string)) warn(`"${st.name}".agent_moves_to apunta a "${st.agent_moves_to}" que ya no existe — corrígelo en workflow.json`)
    }
    if (wf.pr_merged_moves_to && !names.has(wf.pr_merged_moves_to)) warn(`pr_merged_moves_to apunta a "${wf.pr_merged_moves_to}" que ya no existe`)
  }

  // 3. huecos imprescindibles (p. ej. alguien borró Repo, o el workflow ganó handoffs)
  const holes = missingRequired(wf as Parameters<typeof missingRequired>[0], props)
  if (holes.length) {
    console.log(`  Sin equivalente en el board (imprescindibles): ${holes.map(h => h.name).join(', ')}`)
    const go = await ask('  ¿Las agrego al board? (solo agrega — lo existente no se toca) S/n', 'S')
    if (/^\s*[sy]/i.test(go) || go === '') {
      await notion.dataSources.update({
        data_source_id: dsId,
        properties: Object.fromEntries(holes.map(h => [h.name, h.shape])) as never,
      })
      ok(`agregadas: ${holes.map(h => h.name).join(', ')}`)
    } else warn('quedan huecos: los roles imprescindibles sin propiedad no funcionan hasta crearla')
  }

  if (dirty) {
    const go = await ask('  workflow.json quedó desactualizado respecto al board — ¿lo actualizo? S/n', 'S')
    if (/^\s*[sy]/i.test(go) || go === '') {
      fs.writeFileSync(wfPath, JSON.stringify(wf, null, 2) + '\n')
      ok('workflow.json actualizado (comportamiento preservado por nombre de columna)')
    } else warn('workflow.json quedó como estaba; validate puede reportar drift')
  }
}

/**
 * Selector para un rol sin match: lista las columnas del board del tipo correcto
 * y el operador elige por número (0 = crear una nueva con el nombre default).
 * Determinista y confirmado por humano — acá no decide ninguna heurística.
 */
async function pickProp(props: BoardProps, used: Set<string>, label: string, type: string, defName: string): Promise<string> {
  const candidates = Object.keys(props).filter(n => props[n].type === type && !used.has(n))
  if (!candidates.length) { used.add(defName); return defName }
  console.log(`  ${label}: sin match automático. Columnas de tipo ${type} en tu board:`)
  candidates.forEach((n, i) => console.log(`    ${i + 1}. ${n}`))
  const a = await ask(`  ¿Cuál es? (0 = crear "${defName}")`, '0')
  const i = Number(a)
  const chosen = Number.isInteger(i) && i >= 1 && i <= candidates.length ? candidates[i - 1] : defName
  used.add(chosen)
  return chosen
}

/** Igual que pickProp pero para el filtro ejecutor: además elige qué opción significa "humano". */
async function pickFilter(props: BoardProps, used: Set<string>): Promise<{ property: string; skip_value: string }> {
  const property = await pickProp(props, used, 'agent_filter (quién ejecuta el card; marca las tareas humanas que el bridge ignora)', 'select', 'Ejecutor')
  const options = props[property]?.select?.options ?? []
  if (!options.length) return { property, skip_value: 'Humano' }
  options.forEach((o, i) => console.log(`    ${i + 1}. ${o.name}`))
  const guess = options.findIndex(o => /humano|human|manual|persona/i.test(o.name))
  const a = await ask('  ¿Qué opción significa "lo hace un humano"?', String(guess >= 0 ? guess + 1 : 1))
  return { property, skip_value: options[Number(a) - 1]?.name ?? options[0].name }
}

/** bloques de comportamiento comunes a todo workflow.json nuevo */
function defaultBehavior() {
  return {
    chat: { invite_users: [], auto_invite_limit: 15 },
    intake: { model: 'sonnet', timeout_sec: 90 },
    github: { forward_repos: 'auto' },
  }
}

function normalizeGroup(g?: string): 'To-do' | 'In progress' | 'Complete' | undefined {
  if (!g) return undefined
  if (/to-?do/i.test(g)) return 'To-do'
  if (/progress/i.test(g)) return 'In progress'
  if (/complete/i.test(g)) return 'Complete'
  return undefined
}

function defaultAgents() {
  return {
    // pm → dev habilita la "vía rápida" del agent pm (cambios triviales saltan Plan Review)
    pm: { allowed_tools: ['Read', 'Glob', 'Grep'], chat: { username: 'PM 📋' }, can_trigger: ['dev'], triggers: { mentions: ['@pm'] } },
    dev: { allowed_tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash(git:*)', 'Bash(gh:*)', 'Bash(npm:*)', 'Bash(pnpm:*)', 'Bash(node:*)'], chat: { username: 'Dev 🧑‍💻' }, can_trigger: [], triggers: { mentions: ['@dev'] } },
    qa: { allowed_tools: ['Read', 'Glob', 'Grep', 'Bash(gh:*)', 'Bash(git fetch:*)', 'Bash(git diff:*)', 'Bash(npm:*)'], chat: { username: 'QA 🔍' }, can_trigger: ['dev'], triggers: { mentions: ['@qa'] } },
  }
}

function writeDefaultWorkflow(): void {
  const wf = {
    name: 'Regent',
    status_property: 'Status',
    repo_property: 'Repo',
    pr_property: 'PR',
    agent_property: 'Agente',
    hop_property: 'Hop',
    model_property: 'Modelo',
    progress_property: 'Progreso',
    owner_property: 'Owner',
    project_doc_property: 'Proyecto Doc',
    agent_filter: { property: 'Ejecutor', skip_value: 'Humano' },
    max_hops: 3,
    pr_merged_moves_to: 'Done',
    ...defaultBehavior(),
    states: [
      { name: 'Backlog', color: 'gray', group: 'To-do' },
      { name: 'Planning', color: 'yellow', group: 'In progress', trigger: 'pm', agent_moves_to: 'Plan Review' },
      { name: 'Plan Review', color: 'orange', group: 'In progress', gate: 'human' },
      { name: 'In Progress', color: 'blue', group: 'In progress', trigger: 'dev', agent_moves_to: 'Testing', use_worktree: true },
      { name: 'Testing', color: 'purple', group: 'In progress', gate: 'human' },
      { name: 'Done', color: 'green', group: 'Complete', terminal: true },
      { name: 'Canceled', color: 'red', group: 'Complete', terminal: true },
    ],
    agents: defaultAgents(),
  }
  fs.mkdirSync(path.dirname(wfPath), { recursive: true })
  fs.writeFileSync(wfPath, JSON.stringify(wf, null, 2) + '\n')
  ok('workflow.json creado (default)')
}

// ---- 4. process.md: la narrativa del proceso, editable, se inyecta a todos los agentes ----
const processPath = path.join(BRIDGE_DIR, 'config', 'process.md')
if (!fs.existsSync(processPath) && fs.existsSync(wfPath)) {
  const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8')) as { states: Array<{ name: string; trigger?: string; gate?: string; terminal?: boolean; agent_moves_to?: string; agent_stays?: boolean }> }
  const lines = wf.states.map(s => {
    if (s.trigger && s.agent_stays) return `- **${s.name}**: la trabaja el agente \`${s.trigger}\`; el card NO se mueve — el agente avisa por comentario y un humano decide el siguiente paso.`
    if (s.trigger) return `- **${s.name}**: la trabaja el agente \`${s.trigger}\`; al terminar mueve el card a "${s.agent_moves_to}".`
    if (s.gate) return `- **${s.name}**: compuerta humana — un humano revisa y decide (drag o mención para continuar).`
    if (s.terminal) return `- **${s.name}**: estado final.`
    return `- **${s.name}**: columna humana (los agentes no actúan solos aquí).`
  })
  fs.writeFileSync(processPath, `# Proceso del equipo

> Este archivo se inyecta a TODOS los agentes como contexto del proceso. Edítalo libremente:
> matices del equipo, convenciones de PRs, cuándo escalar a humanos, qué significa cada columna.

## Columnas

${lines.join('\n')}

## Reglas del equipo

- El Owner del card es siempre un humano; el agente ejecuta, el humano responde.
- Ante ambigüedad material: pregunta abierta o bloqueo — nunca una suposición silenciosa.
`)
  ok('process.md generado (narrativa del proceso — edítalo a tu gusto)')
} else if (fs.existsSync(processPath)) ok('process.md existe')

// ---- 5. Slack (opcional) ----
console.log('\nSlack (opcional):')
if (env.SLACK_BOT_TOKEN) { ok('tokens de Slack presentes'); await syncSlackManifest() }
else await setupSlackApp()

/**
 * Modo update: el manifest del repo es la fuente de verdad, así que al re-correr
 * el setup se empuja a Slack lo que haya cambiado (scopes, eventos, nombre).
 * Requiere el config token de 12 h; sin él se saltea sin romper nada.
 */
async function syncSlackManifest(): Promise<void> {
  const manifestPath = path.join(BRIDGE_DIR, 'slack-manifest.json')
  if (!fs.existsSync(manifestPath) || !env.SLACK_APP_ID) return
  const cfg = process.env.SLACK_CONFIG_TOKEN
    ?? await ask('  ¿Verificar que el manifest de la app esté al día? App Configuration Token (Enter = saltar)')
  if (!cfg) return

  let appName = 'Regent'
  try { appName = (JSON.parse(fs.readFileSync(wfPath, 'utf8')) as { name?: string }).name ?? appName } catch { /* default */ }
  const desired = brandManifest(manifestPath, appName)

  try {
    const changes = manifestChanges(await exportManifest(cfg, env.SLACK_APP_ID), desired)
    if (!changes.length) return ok('manifest de Slack al día')
    console.log(`  Cambios respecto a la app en Slack: ${changes.join(', ')}`)
    const go = await ask('  ¿Los aplico? S/n', 'S')
    if (!/^\s*[sy]/i.test(go) && go !== '') return void warn('manifest sin aplicar')
    await updateManifest(cfg, env.SLACK_APP_ID, desired)
    ok('manifest actualizado en Slack')
    if (needsReinstall(changes)) {
      warn('cambiaron los scopes: Slack exige REINSTALAR para que el token nuevo los tenga')
      console.log(`    ${installUrl(env.SLACK_APP_ID)} → luego actualiza SLACK_BOT_TOKEN en .env`)
    } else {
      console.log('    (sin cambios de scopes: aplica al instante, no hace falta reinstalar)')
    }
  } catch (err) {
    const m = (err as Error).message
    warn(`no pude sincronizar el manifest: ${m}${/token_expired|invalid_auth/.test(m) ? ' → el config token expira a las 12h' : ''}`)
  }
}

/**
 * Crea la app por API en vez de pedirte que pegues el manifest a mano: con un
 * App Configuration Token, `apps.manifest.create` la deja hecha con el nombre de
 * TU instancia. Slack no deja automatizar dos cosas, y solo esas quedan como
 * clic: instalar en el workspace, y generar el token app-level de Socket Mode.
 */
async function setupSlackApp(): Promise<void> {
  const manifestPath = path.join(BRIDGE_DIR, 'slack-manifest.json')
  if (!fs.existsSync(manifestPath)) return warn('no encontré slack-manifest.json — salteo Slack')

  const cfg = await ask('  App Configuration Token (xoxe.xoxp-…, vacío = sin Slack)\n' +
    '    api.slack.com/apps → "Your App Configuration Tokens" → Generate (expira en 12h)\n  →')
  if (!cfg) return void console.log('  ℹ sin Slack: el pipeline funciona igual (salas y menciones quedan off)')

  let appName = 'Regent'
  try { appName = (JSON.parse(fs.readFileSync(wfPath, 'utf8')) as { name?: string }).name ?? appName } catch { /* default */ }

  let appId: string
  try {
    appId = await createAppFromManifest(cfg, brandManifest(manifestPath, appName),
      seg => console.log(`    ratelimited — espero ${seg}s y reintento…`))
    env.SLACK_APP_ID = appId
    ok(`app "${appName}" creada (${appId})`)
  } catch (err) {
    const m = (err as Error).message
    warn(`no pude crear la app: ${m}${/token_expired|invalid_auth/.test(m) ? ' → el token de configuración expira a las 12h, genera otro' : ''}`)
    return
  }

  console.log(`  1. Instálala (Allow): ${installUrl(appId)}`)
  const bot = await ask('  → Bot User OAuth Token (xoxb-…)')
  if (bot) {
    try {
      const who = await slackApi('auth.test', bot)
      env.SLACK_BOT_TOKEN = bot
      ok(`bot @${who.user} (${who.user_id})`)
    } catch (err) { warn(`token de bot inválido: ${(err as Error).message}`) }
  }

  console.log(`  2. Genera el token app-level con scope connections:write (Socket Mode lo exige;`)
  console.log(`     no hay API para esto): ${appTokenUrl(appId)}`)
  const app = await ask('  → App-Level Token (xapp-…)')
  if (app) {
    try {
      await slackApi('apps.connections.open', app)
      env.SLACK_APP_TOKEN = app
      ok('token app-level válido (Socket Mode listo)')
    } catch (err) { warn(`token app-level inválido: ${(err as Error).message}`) }
  }
}

// ---- 6. GitHub merges por evento ----
console.log('\nGitHub merges por evento:')
if (env.GITHUB_FORWARD_REPOS) {
  warn(`GITHUB_FORWARD_REPOS sigue en .env (${env.GITHUB_FORWARD_REPOS}) y gana sobre workflow.json`)
  console.log('  bórrala del .env para usar github.forward_repos del workflow')
} else {
  ok('github.forward_repos: "auto" en workflow.json — escucha los repos clonados en REPO_PATH')
  console.log('  (el poll con gh queda de respaldo; para fijar una lista, edita github.forward_repos)')
}

// ---- 7. escribir y validar ----
const lines2 = Object.entries(env).filter(([, v]) => v !== '').map(([k, v]) => `${k}="${v}"`)
fs.writeFileSync(envPath, lines2.join('\n') + '\n', { mode: 0o600 })
// `mode` en writeFileSync SOLO aplica al crear: sobre un .env que ya existe no
// cambia nada, y el archivo se queda con los permisos que tuviera (644 típico).
fs.chmodSync(envPath, 0o600)
ok(`.env escrito (${(fs.statSync(envPath).mode & 0o777).toString(8)})`)
console.log('\nValidación:')
try {
  execFileSync(process.execPath, [path.join(BRIDGE_DIR, 'src', 'validate.ts')], { stdio: 'inherit', env: { ...process.env, ...env } })
} catch { warn('validate reportó problemas — corrige y re-corre pnpm setup') }

console.log(`\nSiguientes pasos:
  1. pnpm start  (o pnpm dev en desarrollo)
  2. Túnel con URL estable → suscripción del webhook de Notion en la UI de la conexión
     (eventos: page.properties_updated, comment.created, page.created)
  3. Prueba: crea un card con Repo y coméntale @pm
`)
rl.close()
