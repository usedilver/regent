import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { redact } from '../storage/redact.ts'
import type { Active, Core } from './core.ts'
import { History } from './history.ts'
import type { Intent } from './intent.ts'
import { queryGit } from './query-git.ts'
import {
  isInside,
  isolationFor,
  projectRoot,
  requireSameProject,
  resolveRepository,
} from './repository.ts'
import { RoomTransfers } from './rooms.ts'
import { ToolSchemas } from './tool-schemas.ts'
import type { Conversation } from './types.ts'

export type ToolName = keyof typeof ToolSchemas

export interface ToolCall {
  core: Core
  active: Active
  conversation: Conversation
  token: string
  input: unknown
}

type Handler = (call: ToolCall) => Promise<unknown>

/** Lets the tool result reach the model before the CLI is asked to stop. */
const CANCEL_DELAY_MS = 100
const STATUS_THROTTLE_MS = 3000
const INTENTS: readonly string[] = ['ask', 'patch', 'task', 'project']

async function readHistory({ core, active, input }: ToolCall) {
  const args = ToolSchemas.regent_read_history.parse(input)
  return new History(core.store).read(active.run.id, args.offset, args.max_chars)
}

async function gitRead({ active, conversation, input }: ToolCall) {
  const args = ToolSchemas.regent_git_read.parse(input)

  return queryGit(
    active.executionDir ?? conversation.cwd,
    args.operation,
    args.args,
    args.directory,
    active.abort.signal,
  )
}

async function preview(call: ToolCall) {
  const { core, active, conversation } = call
  const previews = core.previews
  if (!previews) throw new Error('Los previews remotos no estan configurados en esta instancia.')
  const args = ToolSchemas.regent_preview.parse(call.input)

  if (active.readOnly && args.action !== 'status') {
    throw new Error(
      'Query mode can inspect preview status, but cannot start or change project processes.',
    )
  }

  const key = conversation.key
  if (args.action === 'stop') return previews.stop(key)

  if (args.action === 'status') {
    const current = previews.get(key)
    if (current) return { available: true, ...previews.result(current) }
    return {
      available: true,
      ready: false,
      state: 'not_reserved',
      next_action: active.readOnly ? 'none' : 'reserve',
    }
  }

  if (args.action === 'publish') {
    if (!args.pid) {
      throw new Error('Indica el PID del proceso independiente que iniciaste en el worktree.')
    }

    return previews.publish(key, args.pid)
  }

  const reason = await core.prepareWorkspace(call.token)
  if (reason) throw new Error(reason)
  const directory = isolationFor(conversation.cwd, key).dir

  return {
    ...(await previews.reserve(key, directory)),
    instruction:
      'Inicia la app en este worktree usando el puerto reservado y bind 127.0.0.1. Usa Bash y las instrucciones del repo, con un proceso independiente (setsid en Linux), conserva su PID y luego llama publish. Conserva el login y los permisos de la app; el proxy no agrega autenticacion. Configura cookies, redirecciones y origenes permitidos para el host de preview segun las instrucciones del proyecto. Comparte el URL solo cuando publish confirme ready.',
  }
}

async function createRoom({ core, active, conversation, input }: ToolCall) {
  const args = ToolSchemas.regent_create_room.parse(input)

  if (conversation.adapter !== 'slack' || !core.rooms) {
    throw new Error('Crear salas requiere el cliente Slack conectado.')
  }

  if (active.operations.size) {
    throw new Error(
      'Espera a que terminen las otras herramientas antes de trasladar la conversacion.',
    )
  }

  active.moving = true

  try {
    const transfer = await new RoomTransfers(core.store).prepare(
      conversation,
      args,
      core.rooms,
      active.abort.signal,
    )

    if (transfer.state !== 'moved') {
      await active.output
      active.abort.signal.throwIfAborted()
      await core.moveToRoom(active, transfer.channel!)
    }

    await core.output.flush?.().catch(() => {})

    return {
      channel: transfer.channel,
      name: transfer.name,
      url: `slack://channel?team=${conversation.team}&id=${transfer.channel}`,
      moved: true,
      instruction:
        'La misma sesion continua en la sala. No reinicies el repo ni el worktree, no crees una tarea.',
    }
  } finally {
    active.moving = false
  }
}

async function useRepo(call: ToolCall) {
  const { core, active, conversation } = call
  const args = ToolSchemas.regent_use_repo.parse(call.input)

  if (active.readOnly && args.intent && args.intent !== 'ask') {
    throw new Error(
      'Query mode cannot promote itself. Continue with the user request to implement the change.',
    )
  }

  const requested = requestedRepository(core, conversation, args.repo)
  const target = projectRoot(core.cwd, requested)
  requireSameProject(conversation.cwd, target)
  const intent = args.intent ?? active.run.intent
  if (!INTENTS.includes(intent)) throw new Error('Intent invalido.')

  if (target === conversation.cwd && intent === active.run.intent) {
    return {
      repo: target,
      target_repo: requested,
      cwd: path.join(active.executionDir ?? target, path.relative(target, requested)),
      unchanged: true,
      instruction:
        'Mismo proyecto y sesion. Navega al destino indicado, lee sus instrucciones y conserva el contexto compartido y el modo de ejecucion.',
    }
  }

  if (core.store.hasQueued(conversation.key)) {
    throw new Error('Hay mensajes en cola; espera antes de cambiar de proyecto.')
  }

  if (active.operations.size > 0) {
    throw new Error('Espera a que terminen las otras herramientas antes de cambiar de contexto.')
  }

  switchProject(call, target, requested, intent, args.handoff)

  return {
    repo: target,
    switching: true,
    instruction:
      'Termina el turno. Regent continuara con una sesion nueva y el entorno del repositorio seleccionado.',
  }
}

/** A path given inside the isolated worktree is mapped back onto the shared checkout. */
function requestedRepository(core: Core, conversation: Conversation, repo: string): string {
  const requested = resolveRepository(core.cwd, repo)
  const isolatedRoot = isolationFor(conversation.cwd, conversation.key).dir
  if (!isInside(isolatedRoot, requested)) return requested
  const relative = path.relative(isolatedRoot, requested)
  return resolveRepository(core.cwd, path.join(conversation.cwd, relative))
}

/** Queues the continuation in the new project and ends this turn once the model has the answer. */
function switchProject(
  { core, active, conversation }: ToolCall,
  target: string,
  requested: string,
  intent: Intent,
  handoff: string,
): void {
  core.store.accept(
    {
      adapter: conversation.adapter,
      eventId: `context:${active.run.id}`,
      key: conversation.key,
      author: active.run.author,
      team: conversation.team ?? undefined,
      channel: conversation.channel,
      intent,
      thread: conversation.thread ?? undefined,
      replyThread: conversation.thread ?? undefined,
      text: `Continua en el proyecto seleccionado ${target}. Destino dentro del proyecto: ${path.relative(target, requested) || '.'}. Lee su contexto propio. No vuelvas al proyecto de origen.\nObjetivo y estado transferidos:\n${handoff}`,
    },
    target,
    core.config.session.idle_reset_hours,
    true,
  )
  active.contextChanged = true
  active.waiting = true
  active.resumeAfterWait = true
  setTimeout(() => active.controller?.cancel('Cambio de contexto'), CANCEL_DELAY_MS)
}

async function status({ core, active, conversation, input }: ToolCall) {
  const args = ToolSchemas.regent_status.parse(input)
  const text = redact(args.text ?? args.status!)
  const phaseChanged = args.phase !== undefined && args.phase !== active.lastPhase

  if (!phaseChanged && Date.now() - active.lastStatusAt < STATUS_THROTTLE_MS) {
    return { throttled: true }
  }

  await core.output.notice(conversation, text)
  if (args.phase) active.lastPhase = args.phase
  active.lastStatusAt = Date.now()
  return { ok: true }
}

async function askHuman({ core, active, conversation, input }: ToolCall) {
  const args = ToolSchemas.regent_ask_human.parse(input)
  active.waiting = true
  const question = {
    id: randomBytes(16).toString('hex'),
    text: redact(args.question),
    options: (args.options ?? []).map((option) => redact(option)),
  }

  core.store.askGate(conversation.key, question, conversation)

  try {
    if (core.output.question) {
      await core.output.question(conversation, question)
    } else {
      const numbered = question.options.map((option, i) => `${i + 1}. ${option}`)
      await core.output.notice(conversation, [question.text, ...numbered].join('\n'))
    }
  } finally {
    setTimeout(() => active.controller?.cancel('Esperando respuesta humana'), CANCEL_DELAY_MS)
  }

  return {
    waiting_human: true,
    instruction: 'Termina el turno; la respuesta humana reanudara esta sesion.',
  }
}

async function cancel({ active, input }: ToolCall) {
  const args = ToolSchemas.regent_cancel.parse(input)
  active.cancelled = true
  active.cancelReason = redact(args.reason)
  active.abort.abort()
  setTimeout(() => active.controller?.cancel(args.reason), CANCEL_DELAY_MS)
  return { cancelled: true }
}

/** The tools the agent reaches through Regent's own MCP server, by their public names. */
export const CORE_TOOLS: Record<ToolName, Handler> = {
  regent_read_history: readHistory,
  regent_git_read: gitRead,
  regent_preview: preview,
  regent_create_room: createRoom,
  regent_use_repo: useRepo,
  regent_status: status,
  regent_ask_human: askHuman,
  regent_cancel: cancel,
}

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(CORE_TOOLS, name)
}
