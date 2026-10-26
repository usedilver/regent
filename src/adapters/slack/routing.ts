import { CONTROL_COMMANDS } from '../../core/commands.ts'
import { RoomTransfers } from '../../core/rooms.ts'
import type { Store } from '../../storage/store.ts'

const ANSWERABLE_STATES = ['waiting_human', 'interrupted']

/**
 * Invocation rule, enforced in code rather than left to the model: in channels, threads and
 * rooms the bot only acts when mentioned. Without a mention it accepts the conversation's
 * author alone, and only when the bot asked them something (waiting_human/interrupted) or for
 * the exact control commands. DMs are a 1:1 with the bot, so everything is processed.
 */
export function accepts(input: {
  dm: boolean
  mention: boolean
  author: string
  text: string
  conversation?: { author: string; state: string } | null
}): boolean {
  if (input.dm || input.mention) return true
  const c = input.conversation
  if (!c || c.author !== input.author) return false
  if (ANSWERABLE_STATES.includes(c.state)) return true
  return (CONTROL_COMMANDS as readonly string[]).includes(input.text.trim().toLowerCase())
}

export interface SlackRoute {
  dm: boolean
  room: boolean
  key: string
  pending: boolean
  thread: string | undefined
  historyThread: string | undefined
  redirect: string | undefined
}

/** Which conversation a Slack event belongs to, and whether it should be answered elsewhere. */
export function conversationRoute(
  store: Store,
  event: { channel: string; channel_type?: string; thread_ts?: string; ts: string },
): SlackRoute {
  const dm = event.channel_type === 'im' || event.channel.startsWith('D')
  // Only managed rooms share channel-wide state. Legacy DM sessions must not
  // capture new threads or redirect the entire inbox after a room transfer.
  const roomKey = dm ? undefined : store.roomConversationKey(event.channel)
  const pendingKey = dm ? undefined : new RoomTransfers(store).pendingFor(event.channel)
  const room = Boolean(roomKey)
  const key = roomKey ?? pendingKey ?? `slack:${event.channel}:${event.thread_ts ?? event.ts}`
  const destination = store.conversation(key)
  const replyThread = event.thread_ts ?? event.ts

  return {
    dm,
    room,
    key,
    pending: Boolean(pendingKey),
    thread: room ? event.thread_ts : replyThread,
    historyThread: room ? undefined : replyThread,
    redirect:
      destination && destination.channel !== event.channel ? destination.channel : undefined,
  }
}
