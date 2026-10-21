import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps'

const element = (id: string) => document.getElementById(id)!
const displayName = element('heading').textContent ?? 'Regent'
const app = new App({ name: `Progreso de ${displayName}`, version: '1.0.0' }, {}, { autoResize: true })
let runId: string | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let busy = false
let active = true
let failures = 0

function render(data: any) {
  const run = data.latest_run ?? data.run
  if (!run) {
    runId = data.run_id ?? runId
    return
  }
  runId = run.id
  active = ['queued', 'running'].includes(run.state)
  element('heading').textContent = `${displayName} · ${data.activities?.title ?? (active ? 'Trabajando' : 'Estado del trabajo')}`
  element('repo').textContent = data.repo?.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
  element('connection').textContent = data.progress ?? (run.state === 'queued' ? 'Esperando turno' : active ? 'Actualizando automáticamente' : 'Trabajo detenido')
  const list = element('activities')
  list.replaceChildren()
  for (const task of data.activities?.tasks ?? []) {
    const row = document.createElement('li')
    const icon = document.createElement('span')
    icon.className = `icon ${task.status}`
    icon.textContent = task.status === 'complete' ? '✓' : task.status === 'error' ? '!' : '◉'
    const body = document.createElement('div')
    const title = document.createElement('div')
    title.className = 'title'
    title.textContent = task.title
    const detail = document.createElement('div')
    detail.className = 'detail'
    detail.textContent = task.output
    body.append(title, detail)
    row.append(icon, body)
    list.append(row)
  }
  element('question').textContent = data.question?.text ?? ''
  element('result').textContent = run.result ?? run.error ?? ''
  if (!active && !data.progress) element('connection').textContent = 'Estado actualizado'
}

function receive(result: any) {
  if (result.isError) throw new Error('No se pudo leer el progreso')
  const data = result.structuredContent ?? JSON.parse(result.content.find((item: any) => item.type === 'text').text)
  render(data)
}

function schedule() {
  clearTimeout(timer)
  if (active && failures < 3) timer = setTimeout(() => { void refresh() }, 3000)
}

async function refresh() {
  if (!runId || busy) return
  busy = true
  try {
    receive(await app.callServerTool({ name: 'regent_get_run', arguments: { run_id: runId } }))
    failures = 0
  } catch {
    failures++
    element('connection').textContent = failures < 3 ? 'Conexión interrumpida. Reintentando…' : 'No se pudo actualizar. Puedes reintentar con Actualizar.'
  } finally {
    busy = false
    schedule()
  }
}

app.ontoolresult = result => {
  try { receive(result); schedule() }
  catch { element('connection').textContent = 'No se pudo leer este trabajo.' }
}
app.onteardown = async () => { active = false; clearTimeout(timer); return {} }
function theme(context: any) {
  if (context?.theme) applyDocumentTheme(context.theme)
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables)
}
app.onhostcontextchanged = theme
element('refresh').addEventListener('click', () => { failures = 0; void refresh() })
void app.connect().then(() => theme(app.getHostContext())).catch(() => { element('connection').textContent = 'Este cliente no pudo conectar el panel. Consulta el estado desde el chat.' })
