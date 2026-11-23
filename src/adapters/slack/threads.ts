import type { Conversation, ThreadProposalMessage, Threads } from '../../core/types.ts'
import { redact } from '../../storage/redact.ts'
import type { SlackApi } from './api.ts'

export const THREAD_OPEN_ACTION = 'regent_thread_open'
export const THREAD_STAY_ACTION = 'regent_thread_stay'

/** Proposals to continue in another project's thread, opened in the same channel or DM. */
export function createThreadApi(api: SlackApi): Threads {
  return {
    async propose(c: Conversation, proposal: ThreadProposalMessage) {
      const text = `Para trabajar en *${proposal.project}* conviene un hilo aparte; este hilo sigue con *${proposal.current}*. ¿Abro uno nuevo en este mismo canal?`
      const response = await api('chat.postMessage', {
        channel: c.channel,
        thread_ts: c.thread ?? undefined,
        text,
        unfurl_links: false,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text } },
          {
            type: 'context',
            elements: [{ type: 'plain_text', text: redact(proposal.summary) || ' ' }],
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                style: 'primary',
                text: { type: 'plain_text', text: 'Abrir hilo nuevo' },
                action_id: THREAD_OPEN_ACTION,
                value: proposal.id,
              },
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Seguir aquí' },
                action_id: THREAD_STAY_ACTION,
                value: proposal.id,
              },
            ],
          },
        ],
      })
      return response.ts as string
    },

    async open(channel, text) {
      const response = await api('chat.postMessage', {
        channel,
        text: redact(text),
        unfurl_links: false,
        unfurl_media: false,
      })
      return response.ts as string
    },

    async permalink(channel, ts) {
      try {
        return (await api('chat.getPermalink', { channel, message_ts: ts })).permalink as string
      } catch {
        return undefined
      }
    },

    async settle(channel, ts, text) {
      await api('chat.update', {
        channel,
        ts,
        text,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
      })
    },

    async whisper(channel, thread, user, text) {
      await api('chat.postEphemeral', { channel, thread_ts: thread ?? undefined, user, text })
    },
  }
}
