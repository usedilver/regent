import { createHash } from 'node:crypto'
import { redact } from './store.ts'
import { commandDisplay } from './command-display.ts'

export type ActivityState = {
  calls: Record<string, { group: string; tool?: string; command?: string; status: 'running' | 'complete' | 'error' }>
  terminal?: string
}
const titles: Record<string, string> = {
  read: 'Consultando archivos', edit: 'Modificando archivos', command: 'Ejecutando comandos',
  delegate: 'Trabajo delegado', skill: 'Aplicando instrucciones del repositorio',
  external: 'Consultando herramientas externas', other: 'Procesando la solicitud',
}
function group(name: string) {
  if (['Read', 'Glob', 'Grep'].includes(name)) return 'read'
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return 'edit'
  if (['Agent', 'Task'].includes(name)) return 'delegate'
  if (name === 'Bash') return 'command'
  if (name === 'Skill') return 'skill'
  return name.startsWith('mcp__') ? 'external' : 'other'
}
export function activityEvent(state: ActivityState, event: any): boolean {
  if (state.terminal || !event.id || !['tool_use', 'tool_result'].includes(event.kind)) return false
  const id = createHash('sha256').update(JSON.stringify([event.parentId ?? '', event.id])).digest('hex')
  if (event.kind === 'tool_use') {
    if (state.calls[id] || Object.keys(state.calls).length >= 2000) return false
    const name = typeof event.name === 'string' ? event.name : ''
    const tool = /^[A-Za-z0-9_:-]{1,120}$/.test(name) && redact(name) === name ? name : undefined
    const command = name === 'Bash' ? commandDisplay(event.input?.command)?.command : undefined
    state.calls[id] = { group: group(name), tool, command, status: 'running' }
  } else {
    const call = state.calls[id]
    if (!call || call.status !== 'running') return false
    // A background launch is not completion of the underlying operation.
    if (event.background) return false
    call.status = event.error ? 'error' : 'complete'
  }
  return true
}
export function activityView(state: ActivityState) {
  const groups = new Map<string, { running: number; complete: number; error: number }>()
  for (const call of Object.values(state.calls)) {
    const counts = groups.get(call.group) ?? { running: 0, complete: 0, error: 0 }
    counts[call.status]++; groups.set(call.group, counts)
  }
  const title = state.terminal === 'completed' ? 'Turno finalizado' : state.terminal === 'waiting_human' ? 'Esperando tu respuesta' : state.terminal === 'moved' ? 'Continuamos en la sala' : state.terminal ? 'Turno detenido' : 'Progreso'
  const tasks = [...groups].map(([id, n]) => {
    const calls = Object.values(state.calls).filter(call => call.group === id)
    const display = (call: typeof calls[number]) => commandDisplay(call.command)?.command ?? call.tool
    const tools = [...new Set(calls.map(display).filter(Boolean))].slice(0, 8)
    const active = calls.findLast(call => call.status === 'running' && call.tool) ?? calls.at(-1)
    const current = active ? display(active) : undefined
    const heading = commandDisplay(active?.command)?.title ?? titles[id]
    return { id, title: `${heading}${current ? `: ${current}` : ''}`,
    details: tools.join('\n'),
    status: n.running && !state.terminal ? 'in_progress' : n.error || n.running ? 'error' : 'complete',
    output: [
      `${n.complete} ${n.complete === 1 ? 'ejecucion terminada' : 'ejecuciones terminadas'}`,
      ...(n.error ? [`${n.error} con error`] : []),
      ...(n.running ? [`${n.running} ${state.terminal ? 'sin confirmar' : 'en curso'}`] : []),
    ].join('\n'),
  } })
  return { title, tasks, text: [title, ...tasks.map(t => `${t.title}: ${t.output}`)].join('\n') }
}
