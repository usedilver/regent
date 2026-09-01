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
  ok('workflow.json y board configurados — no los toco (borra workflow.json para re-derivar)')
} else {
  const boardRef = await ask('  ¿Ya tienes un board? Pega su URL o ID (vacío = crear uno default)')
  if (boardRef && env.NOTION_TOKEN) {
    await adoptBoard(boardRef)
  } else if (!wfExists) {
    writeDefaultWorkflow()
    console.log('  Para crear el board desde este workflow: comparte una página con la conexión y corre')
    console.log('  node src/setup-board.ts --parent <page_id>  (luego pega los IDs que imprime en .env)')
  }
}

/** Lee el board del usuario y deriva workflow.json de SUS columnas. */
async function adoptBoard(ref: string): Promise<void> {
  const { Client } = await import('@notionhq/client')
  const notion = new Client({ auth: env.NOTION_TOKEN })
  const dbId = ref.match(/[0-9a-f]{32}/i)?.[0] ?? ref
  const db = await notion.databases.retrieve({ database_id: dbId }) as { id: string; data_sources?: Array<{ id: string }> }
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
  const iPlan = await pick('¿Qué columna dispara al PM (planificar)?', /plan/i, true)
  const iPlanTo = iPlan >= 0 ? await pick('  → ¿a qué columna mueve el card al terminar?', /review|revis/i) : -1
  const iImpl = await pick('¿Qué columna dispara al DEV (codear)?', /progress|desarrollo|doing|impl|curso/i, true)
  const iImplTo = iImpl >= 0 ? await pick('  → ¿a qué columna mueve al terminar?', /test|qa|review/i) : -1

  const states = options.map((o, i) => {
    const s: Record<string, unknown> = { name: o.name, color: o.color, group: normalizeGroup(groupOf[o.id]) }
    if (i === iPlan) { s.trigger = 'pm'; s.agent_moves_to = options[iPlanTo]?.name }
    if (i === iImpl) { s.trigger = 'dev'; s.agent_moves_to = options[iImplTo]?.name; s.use_worktree = true }
    if (normalizeGroup(groupOf[o.id]) === 'Complete') s.terminal = true
    return s
  })
  const terminals = states.filter(s => s.terminal).map(s => s.name as string)
  const mergedDef = terminals.find(t => /done|complet|listo|termin/i.test(t)) ?? terminals[0] ?? ''
  const mergedTo = await ask('  ¿A qué columna va un card cuando su PR se mergea? (vacío = off)', mergedDef)
  const docProp = await ask('  ¿Propiedad que enlaza al doc de proyecto? (vacío = sin doc)', 'Proyecto Doc')

  const appName = await ask('  ¿Cómo se llama tu app? (así firma en el chat y así la mencionas)', 'Regent')
  const detected = detectProps(ds.properties as BoardProps)
  const wf = {
    name: appName,
    status_property: statusProp,
    ...detected,
    max_hops: 3,
    ...(mergedTo ? { pr_merged_moves_to: mergedTo } : {}),
    ...(docProp ? { project_doc_property: docProp } : {}),
    ...defaultBehavior(),
    states,
    agents: defaultAgents(),
  }
  fs.mkdirSync(path.dirname(wfPath), { recursive: true })
  fs.writeFileSync(wfPath, JSON.stringify(wf, null, 2) + '\n')
  env.DATABASE_ID = db.id.replace(/-/g, '')
  env.DATA_SOURCE_ID = dsId
  ok('workflow.json derivado de TU board (edítalo cuando quieras) + IDs al .env')
  const missing = Object.entries(detected)
    .filter(([k, v]) => v === null && k.endsWith('_property'))
    .map(([k]) => k.replace('_property', ''))
  if (missing.length) {
    console.log(`  ℹ tu board no tiene: ${missing.join(', ')} — el pipeline funciona sin ellas,`)
    console.log('    pero handoffs entre agentes necesitan agent+hop (créalas o corre setup-board --apply)')
  }
}

type BoardProps = Record<string, { type?: string; select?: { options: Array<{ name: string }> } }>

/**
 * Deriva los nombres de propiedad del board REAL en vez de asumirlos en español.
 * Cada rol se busca por tipo + nombre; lo que no está queda en null y el pipeline
 * simplemente no usa esa propiedad (el esquema las declara nullable).
 */
function detectProps(props: BoardProps) {
  const find = (type: string, re: RegExp): string | null =>
    Object.entries(props).find(([n, p]) => p.type === type && re.test(n))?.[0] ?? null

  // "Ejecutor: Humano" — un select con una opción que significa humano marca las tareas que el bridge ignora
  let agentFilter: { property: string; skip_value: string } | null = null
  for (const [name, p] of Object.entries(props)) {
    if (p.type !== 'select') continue
    const human = p.select?.options.find(o => /humano|human|persona|manual/i.test(o.name))
    if (human && /ejecutor|assignee|ejecuta|owner type|tipo/i.test(name)) {
      agentFilter = { property: name, skip_value: human.name }
      break
    }
  }

  return {
    repo_property: find('url', /repo|repositor/i) ?? 'Repo',
    pr_property: find('url', /^pr$|pull|merge request/i) ?? 'PR',
    agent_property: find('select', /agente|agent\b/i),
    hop_property: find('number', /hop|salto/i),
    model_property: find('select', /modelo|model/i),
    progress_property: find('number', /progreso|progress|avance/i),
    owner_property: find('people', /owner|dueñ|responsab/i),
    participants_property: find('people', /involucrad|particip|watcher|equipo/i) ?? undefined,
    agent_filter: agentFilter,
  }
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
  const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8')) as { states: Array<{ name: string; trigger?: string; gate?: string; terminal?: boolean; agent_moves_to?: string }> }
  const lines = wf.states.map(s => {
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
if (env.SLACK_BOT_TOKEN) ok('tokens de Slack presentes')
else {
  console.log('  https://api.slack.com/apps → "From an app manifest" → pega slack-manifest.json → Install')
  const bot = await ask('  SLACK_BOT_TOKEN (xoxb-…, vacío = sin Slack)')
  if (bot) {
    env.SLACK_BOT_TOKEN = bot
    env.SLACK_APP_TOKEN = await ask('  SLACK_APP_TOKEN (xapp-…)')
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
ok('.env escrito (600)')
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
