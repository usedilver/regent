#!/usr/bin/env node
/**
 * setup-board — crea (o repara) el board de Notion desde el workflow del REPO DEL CLIENTE.
 *
 * Uso:
 *   node src/setup-board.ts --parent <page_id>              # crea database bajo una página compartida
 *   node src/setup-board.ts --ensure-props <data_source_id> # agrega al board las propiedades que faltan
 *   node src/setup-board.ts --apply <data_source_id>        # aplica estados a un board existente
 *   node src/setup-board.ts --title "Mi Board"
 *
 * Lee REPO_PATH del .env y los estados de <repo>/.bridge/workflow.json.
 * Límite conocido de la API (verificado 2026-08): crea opciones de Status con nombre/color/orden,
 * pero NO asigna grupos (To-do/In progress/Complete) — arrastrar en la UI, cosmético.
 */
import { Client } from '@notionhq/client'
import { loadEnv } from './env.ts'
import { loadBridge } from './bridge-config.ts'
import { detectProps, missingRequired, type BoardProps } from './board-detect.ts'

loadEnv()
if (!process.env.NOTION_TOKEN) {
  console.error('setup-board: falta NOTION_TOKEN en .env')
  process.exit(1)
}

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const parentPageId = flag('parent')
const applyDataSourceId = flag('apply')
const ensurePropsDataSourceId = flag('ensure-props')
const allowStatusPrune = args.includes('--allow-status-prune')
const title = flag('title') ?? 'Coding Task Board'

const notion = new Client({ auth: process.env.NOTION_TOKEN })
const bridge = loadBridge()
const { config } = bridge
const statusOptions = config.states.map(s => ({ name: s.name, color: (s.color ?? 'default') as 'default' }))

async function applyStatusOptions(dataSourceId: string) {
  // Merge idempotente: preserva ids existentes (no pierde valores de cards ni grupos),
  // agrega faltantes, aplica el orden del workflow. ⚠️ options REEMPLAZA el set completo.
  const before = await notion.dataSources.retrieve({ data_source_id: dataSourceId }) as {
    properties: Record<string, { status?: { options: Array<{ id: string; name: string; color: string }> } }>
  }
  const existing = before.properties[config.status_property]?.status?.options ?? []
  const byName = Object.fromEntries(existing.map(o => [o.name, o]))
  const dropped = existing.filter(o => !config.states.some(s => s.name === o.name)).map(o => o.name)
  if (dropped.length && !allowStatusPrune) {
    console.error(`✋ aplicar este workflow BORRARÍA ${dropped.length} opciones de "${config.status_property}" y el valor de todos los cards que las usan:
     ${dropped.join(', ')}

En un board compartido eso es pérdida de datos. Alinea los estados en config/workflow.json
con los del board, o pasa --allow-status-prune si de verdad querés reemplazarlos.`)
    process.exit(1)
  }
  if (dropped.length) console.warn(`⚠️  opciones fuera del workflow que se ELIMINARÁN: ${dropped.join(', ')}`)
  const options = config.states.map(s => byName[s.name]
    ? { id: byName[s.name].id, name: s.name, color: (s.color ?? byName[s.name].color) as 'default' }
    : { name: s.name, color: (s.color ?? 'default') as 'default' })
  await notion.dataSources.update({
    data_source_id: dataSourceId,
    properties: { [config.status_property]: { status: { options } } },
  })
  const ds = await notion.dataSources.retrieve({ data_source_id: dataSourceId }) as {
    properties: Record<string, { status?: { options: Array<{ name: string }> } }>
  }
  console.log(`Status aplicado:`, ds.properties[config.status_property]?.status?.options.map(o => o.name).join(' → '))
}

/**
 * Agrega SOLO los huecos imprescindibles que el matcher no resolvió contra lo
 * existente (tipo+propósito, board-detect). Nunca toca una propiedad del cliente.
 */
async function ensureProps(dataSourceId: string) {
  const ds = await notion.dataSources.retrieve({ data_source_id: dataSourceId }) as { properties: BoardProps }
  const detected = detectProps(ds.properties)
  for (const [role, name] of Object.entries(detected)) {
    if (name) console.log(`  ${role} → ${typeof name === 'string' ? `"${name}"` : `"${name.property}" (skip: ${name.skip_value})`}`)
  }
  const holes = missingRequired({ ...config, agents: config.agents }, ds.properties)
  if (!holes.length) {
    console.log('Propiedades: el board ya cubre todo lo que este workflow necesita.')
    return
  }
  await notion.dataSources.update({
    data_source_id: dataSourceId,
    properties: Object.fromEntries(holes.map(h => [h.name, h.shape])) as never,
  })
  console.log(`Propiedades agregadas: ${holes.map(h => h.name).join(', ')}`)
}

if (ensurePropsDataSourceId) {
  await ensureProps(ensurePropsDataSourceId)
  process.exit(0)
}

if (applyDataSourceId) {
  await applyStatusOptions(applyDataSourceId)
  process.exit(0)
}

if (!parentPageId) {
  console.error(`setup-board: falta --parent <page_id>.
Las integraciones internas no pueden crear databases a nivel workspace.
Crea una página, compártela con la conexión (··· → Connections), y pasa su ID.`)
  process.exit(1)
}

const db = await notion.databases.create({
  parent: { type: 'page_id', page_id: parentPageId },
  title: [{ type: 'text', text: { content: title } }],
  initial_data_source: {
    properties: {
      Name: { type: 'title', title: {} },
      [config.status_property]: { type: 'status', status: { options: statusOptions } },
      RFC: { type: 'url', url: {} },
      [config.repo_property]: { type: 'url', url: {} },
      PR: { type: 'url', url: {} },
      'Estimación': { type: 'select', select: { options: [{ name: 'S', color: 'green' }, { name: 'M', color: 'yellow' }, { name: 'L', color: 'red' }] } },
      Ejecutor: { type: 'select', select: { options: [{ name: 'Agente', color: 'purple' }, { name: 'Humano', color: 'blue' }] } },
      Modelo: { type: 'select', select: { options: [{ name: 'haiku', color: 'green' }, { name: 'sonnet', color: 'blue' }, { name: 'opus', color: 'purple' }, { name: 'fable', color: 'orange' }] } },
      Progreso: { type: 'number', number: { format: 'number' } },
      Owner: { type: 'people', people: {} },
      ...(config.participants_property ? { [config.participants_property]: { type: 'people', people: {} } } : {}),
      Agente: { type: 'select', select: { options: [] } },
      Hop: { type: 'number', number: { format: 'number' } },
    },
  },
}) as { id: string; url?: string; data_sources?: Array<{ id: string }> }

const dataSourceId = db.data_sources?.[0]?.id
console.log(`Database creada: ${db.url ?? db.id}`)
if (dataSourceId) await applyStatusOptions(dataSourceId) // por si el create ignoró opciones

console.log(`
Agrega a .env:
  DATABASE_ID="${db.id.replace(/-/g, '')}"
  DATA_SOURCE_ID="${dataSourceId}"

Pasos restantes:
  1. Mueve la database a su lugar en el workspace.
  2. (Cosmético) Status → Edit property: arrastra opciones a sus grupos —
     In progress: ${config.states.filter(s => s.group === 'In progress').map(s => s.name).join(', ')}
     Complete: ${config.states.filter(s => s.group === 'Complete').map(s => s.name).join(', ')}
  3. Suscripción del webhook (ver README).
`)
