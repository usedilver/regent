import type { Rooms } from '../../core/types.ts'
import { isSlackError, type SlackApi } from './api.ts'

/** Slack private channels as the rooms a conversation can move into. */
export function createRoomApi(api: SlackApi, team: string, bot: () => string): Rooms {
  const rooms: Rooms = {
    async validateUser(id) {
      const { user } = await api('users.info', { user: id })

      if (!user || user.deleted || user.is_bot || user.is_stranger || user.team_id !== team) {
        throw new Error(`No puedo invitar al usuario ${id} de este workspace.`)
      }
    },

    /** A private channel with that name that the bot itself created and still belongs to. */
    async find(name) {
      let cursor: string | undefined
      const seen = new Set<string>()

      do {
        const result = await api('conversations.list', {
          types: 'private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        })
        const channel = result.channels?.find(
          (c: any) => c.name === name && c.is_member && c.creator === bot(),
        )

        if (channel) return channel.id
        cursor = result.response_metadata?.next_cursor || undefined
        if (cursor && seen.has(cursor)) throw new Error('Slack repitio el cursor de salas.')
        if (cursor) seen.add(cursor)
      } while (cursor)

      return undefined
    },

    async create(name) {
      try {
        const result = await api('conversations.create', { name, is_private: true })
        if (!result.channel?.id) throw new Error('Slack no devolvio la sala creada.')
        return result.channel.id
      } catch (error) {
        // A lost create response leaves the channel behind; the persisted name finds it again.
        if (isSlackError(error, 'name_taken')) {
          const channel = await rooms.find(name)
          if (channel) return channel
        }

        throw error
      }
    },

    async invite(channel, user) {
      try {
        await api('conversations.invite', { channel, users: user })
      } catch (error) {
        if (!isSlackError(error, 'already_in_channel')) throw error
      }
    },
  }

  return rooms
}
