import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { ThreadProposal } from '../storage/store.ts'
import type { Core } from './core.ts'
import { isInside, projectRoot, resolveRepository } from './repository.ts'
import type { Conversation } from './types.ts'

/** A proposal nobody answered within a day no longer reflects the conversation. */
export const THREAD_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000
const SUMMARY_PREVIEW_CHARS = 400

const SAME_PROJECT =
  'Ese repositorio es parte de este mismo proyecto (submodulo, servicio o worktree): sigue en este hilo y usa regent_use_repo. Solo se propone un hilo nuevo para un proyecto independiente.'

export interface ThreadProposalRequest {
  conversation: Conversation
  author: string
  team?: string | null
  repo: string
  summary: string
  runId?: string
}

export type ThreadProposalResult =
  | { proposed: ThreadProposal }
  | { pending: ThreadProposal }
  | { opened: ThreadProposal }

export interface ThreadAnswer {
  id: string
  open: boolean
  user: string
  team?: string
  channel: string
}

function label(core: Core, dir: string): string {
  return path.relative(core.cwd, dir) || path.basename(dir)
}

function expired(proposal: ThreadProposal): boolean {
  return Date.now() - proposal.created_at > THREAD_PROPOSAL_TTL_MS
}

/** The independent project behind `repo`; anything inside the current project is refused. */
export function independentProject(core: Core, conversation: Conversation, repo: string): string {
  let target: string

  try {
    target = resolveRepository(core.cwd, repo)
  } catch {
    throw new Error(`No encontre el proyecto "${repo}" en el workspace.`)
  }

  if (isInside(conversation.cwd, target)) throw new Error(SAME_PROJECT)
  const project = projectRoot(core.cwd, target)
  if (isInside(conversation.cwd, project)) throw new Error(SAME_PROJECT)
  return project
}

/**
 * Asks the requester, with buttons, whether to continue in a new thread for another project.
 * Nothing is opened here: only the requester's confirmation does that.
 */
export async function proposeThread(
  core: Core,
  request: ThreadProposalRequest,
): Promise<ThreadProposalResult> {
  const { conversation } = request

  if (conversation.adapter !== 'slack' || !core.threads) {
    throw new Error(
      'Abrir un hilo nuevo solo existe en Slack; desde MCP usa regent_start con el repo.',
    )
  }

  const project = independentProject(core, conversation, request.repo)
  const name = label(core, project)
  const proposals = core.store.threadProposals(conversation.key)
  const opened = proposals.find((p) => p.project === project && p.state === 'opened')
  if (opened) return { opened }
  const pending = proposals.find((p) => ['pending', 'opening'].includes(p.state) && !expired(p))

  if (pending && pending.project === project) return { pending }

  if (pending) {
    throw new Error(
      `Ya hay una propuesta de hilo pendiente para ${label(core, pending.project)}; espera la respuesta.`,
    )
  }

  const declinedNow = proposals.some(
    (p) => p.project === project && p.state === 'declined' && p.resume_run_id === request.runId,
  )

  if (request.runId && declinedNow) {
    throw new Error(
      `El solicitante eligio seguir en este hilo en lugar de abrir uno para ${name}; no lo vuelvas a proponer salvo que lo pida.`,
    )
  }

  const proposal = {
    id: randomBytes(16).toString('hex'),
    conversation_key: conversation.key,
    project,
    summary: request.summary,
    author: request.author,
    team: request.team ?? null,
    channel: conversation.channel,
    thread: conversation.thread,
    run_id: request.runId ?? null,
  }
  core.store.proposeThread(proposal)
  const ts = await core.threads.propose(conversation, {
    id: proposal.id,
    project: name,
    current: label(core, conversation.cwd),
    summary: request.summary.slice(0, SUMMARY_PREVIEW_CHARS),
  })
  core.store.updateThreadProposal(proposal.id, { message_ts: ts })
  return { proposed: core.store.threadProposal(proposal.id)! }
}

/** Where an opened thread lives, as a link when Slack can give one. */
export async function threadLink(core: Core, proposal: ThreadProposal): Promise<string> {
  if (!proposal.opened_channel || !proposal.opened_thread) return 'el hilo nuevo'
  const link = await core.threads?.permalink(proposal.opened_channel, proposal.opened_thread)
  return link ?? 'el hilo nuevo'
}

/**
 * The requester pressed a button. Only they can decide; the first decision wins, so a double
 * click opens one thread at most.
 */
export async function answerThread(
  core: Core,
  answer: ThreadAnswer,
): Promise<{ duplicate: boolean }> {
  const proposal = core.store.threadProposal(answer.id)
  const threads = core.threads
  if (!proposal || !threads) throw new Error('Esta propuesta ya no existe.')

  if (!core.authorized({ adapter: 'slack', author: answer.user, team: answer.team } as never)) {
    throw new Error('Usuario o workspace no autorizado.')
  }

  if (proposal.channel !== answer.channel) throw new Error('La propuesta pertenece a otro canal.')

  if (answer.user !== proposal.author) {
    throw new Error(`Solo <@${proposal.author}> puede decidir esta propuesta.`)
  }

  const name = label(core, proposal.project)
  const message = proposal.message_ts

  if (proposal.state === 'pending' && expired(proposal)) {
    core.store.claimThreadProposal(proposal.id, 'pending', 'failed')
    if (message) await threads.settle(proposal.channel, message, 'La propuesta vencio.')
    throw new Error('La propuesta vencio; pidelo de nuevo en el hilo.')
  }

  if (!answer.open) {
    if (!core.store.claimThreadProposal(proposal.id, 'pending', 'declined'))
      return { duplicate: true }
    if (message) await threads.settle(proposal.channel, message, 'Seguimos en este hilo.')
    const accepted = await core.submit({
      adapter: 'slack',
      eventId: `thread-declined:${proposal.id}`,
      key: proposal.conversation_key,
      author: answer.user,
      team: answer.team,
      channel: proposal.channel,
      thread: proposal.thread ?? undefined,
      replyThread: proposal.thread ?? undefined,
      text: `El solicitante prefirio seguir en este hilo en lugar de abrir uno para ${name}. Continua aqui sin editar ese proyecto.`,
    })
    core.store.updateThreadProposal(proposal.id, { resume_run_id: accepted.runId })
    return { duplicate: false }
  }

  if (!core.store.claimThreadProposal(proposal.id, 'pending', 'opening')) return { duplicate: true }

  try {
    await openThread(core, proposal, answer, name)
  } catch (error) {
    core.store.updateThreadProposal(proposal.id, { state: 'failed' })
    if (message) await threads.settle(proposal.channel, message, 'No pude abrir el hilo nuevo.')
    throw error
  }

  return { duplicate: false }
}

async function openThread(
  core: Core,
  proposal: ThreadProposal,
  answer: ThreadAnswer,
  name: string,
): Promise<void> {
  const threads = core.threads!
  const origin = proposal.thread ?? proposal.message_ts
  const originLink = origin ? await threads.permalink(proposal.channel, origin) : undefined
  const from = originLink ? `<${originLink}|este hilo>` : 'otro hilo'
  const preview = proposal.summary.slice(0, SUMMARY_PREVIEW_CHARS)
  const ts = await threads.open(
    proposal.channel,
    `<@${proposal.author}> Hilo para trabajar en *${name}*, abierto desde ${from}.\n> ${preview.replaceAll('\n', '\n> ')}`,
  )
  core.store.updateThreadProposal(proposal.id, {
    opened_channel: proposal.channel,
    opened_thread: ts,
  })
  await core.submit({
    adapter: 'slack',
    eventId: `thread-opened:${proposal.id}`,
    key: `slack:${proposal.channel}:${ts}`,
    author: answer.user,
    team: answer.team,
    channel: proposal.channel,
    thread: ts,
    replyThread: ts,
    repo: proposal.project,
    text: `Continuacion de ${originLink ?? 'otro hilo'}, en el proyecto ${name}. Resumen de ese hilo:\n${proposal.summary}\n\nEste hilo trabaja solo en ${name}.`,
  })
  core.store.updateThreadProposal(proposal.id, { state: 'opened' })
  const link = await threadLink(core, core.store.threadProposal(proposal.id)!)
  if (proposal.message_ts) {
    await threads.settle(
      proposal.channel,
      proposal.message_ts,
      `Abri el hilo para ${name}: ${link}`,
    )
  }

  const conversation = core.store.conversation(proposal.conversation_key)
  if (conversation?.state === 'waiting_human' && !core.active.has(proposal.conversation_key)) {
    core.store.state(proposal.conversation_key, 'idle')
  }
}
