import { createHash } from 'node:crypto'
import { redact } from '../storage/redact.ts'
import { commandDisplay } from './command-display.ts'
import type { RunnerEvent } from '../execution/runner.ts'

export type WorkspaceActivity = {
  kind: 'workspace_preparation'
  status: 'running' | 'complete' | 'error'
}
export type ActivityEvent = RunnerEvent | WorkspaceActivity

export type ActivityState = {
  calls: Record<
    string,
    { group: string; tool?: string; command?: string; status: 'running' | 'complete' | 'error' }
  >
  terminal?: string
}

const titles: Record<string, string> = {
  read: 'Consultando archivos',
  edit: 'Modificando archivos',
  command: 'Ejecutando comandos',
  delegate: 'Trabajo delegado',
  skill: 'Aplicando instrucciones del repositorio',
  external: 'Consultando herramientas externas',
  other: 'Procesando la solicitud',
  workspace: 'Preparando el espacio de trabajo',
}

const terminalTitles: Record<string, string> = {
  completed: 'Turno finalizado',
  waiting_human: 'Esperando tu respuesta',
  moved: 'Continuamos en la sala',
}

function group(name: string) {
  if (['Read', 'Glob', 'Grep'].includes(name)) return 'read'
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return 'edit'
  if (['Agent', 'Task'].includes(name)) return 'delegate'
  if (name === 'Bash') return 'command'
  if (name === 'Skill') return 'skill'
  return name.startsWith('mcp__') ? 'external' : 'other'
}

const MAX_CALLS = 2000
const TOOL_NAME = /^[A-Za-z0-9_:-]{1,120}$/

/** Stable id for a tool call: subagent calls carry their parent, so ids never collide. */
function callId(event: any): string {
  return createHash('sha256')
    .update(JSON.stringify([event.parentId ?? '', event.id]))
    .digest('hex')
}

function openCall(state: ActivityState, id: string, event: any): boolean {
  if (state.calls[id] || Object.keys(state.calls).length >= MAX_CALLS) return false
  const name = typeof event.name === 'string' ? event.name : ''
  const tool = TOOL_NAME.test(name) && redact(name) === name ? name : undefined
  const command = name === 'Bash' ? commandDisplay(event.input?.command)?.command : undefined
  state.calls[id] = { group: group(name), tool, command, status: 'running' }
  return true
}

function closeCall(state: ActivityState, id: string, event: any): boolean {
  const call = state.calls[id]
  if (!call || call.status !== 'running') return false
  // A background launch is not completion of the underlying operation.
  if (event.background) return false
  call.status = event.error ? 'error' : 'complete'
  return true
}

/** Folds an activity event into the state; true when the view changed. */
export function activityEvent(state: ActivityState, event: any): boolean {
  if (state.terminal) return false
  if (event.kind === 'workspace_preparation') {
    if (!['running', 'complete', 'error'].includes(event.status)) return false
    const previous = state.calls.workspace_preparation
    if (previous && (previous.status !== 'running' || previous.status === event.status))
      return false
    state.calls.workspace_preparation = { group: 'workspace', status: event.status }
    return true
  }
  if (!event.id) return false
  if (event.kind === 'tool_use') return openCall(state, callId(event), event)
  if (event.kind === 'tool_result') return closeCall(state, callId(event), event)
  return false
}

export function activityView(state: ActivityState) {
  const groups = new Map<string, { running: number; complete: number; error: number }>()

  for (const call of Object.values(state.calls)) {
    const counts = groups.get(call.group) ?? { running: 0, complete: 0, error: 0 }
    counts[call.status]++
    groups.set(call.group, counts)
  }

  const title = state.terminal ? (terminalTitles[state.terminal] ?? 'Turno detenido') : 'Progreso'
  const tasks = [...groups].map(([id, n]) => {
    const calls = Object.values(state.calls).filter((call) => call.group === id)
    const display = (call: (typeof calls)[number]) =>
      commandDisplay(call.command)?.command ?? call.tool
    const tools = [...new Set(calls.map(display).filter(Boolean))].slice(0, 8)
    const active = calls.findLast((call) => call.status === 'running' && call.tool) ?? calls.at(-1)
    const current = active ? display(active) : undefined
    const heading = commandDisplay(active?.command)?.title ?? titles[id]
    let status: 'in_progress' | 'error' | 'complete' = 'complete'
    if (n.running && !state.terminal) status = 'in_progress'
    else if (n.error || n.running) status = 'error'

    return {
      id,
      title: `${heading}${current ? `: ${current}` : ''}`,
      details: tools.join('\n'),
      status,
      output: [
        `${n.complete} ${n.complete === 1 ? 'ejecucion terminada' : 'ejecuciones terminadas'}`,
        ...(n.error ? [`${n.error} con error`] : []),
        ...(n.running ? [`${n.running} ${state.terminal ? 'sin confirmar' : 'en curso'}`] : []),
      ].join('\n'),
    }
  })

  return { title, tasks, text: [title, ...tasks.map((t) => `${t.title}: ${t.output}`)].join('\n') }
}
