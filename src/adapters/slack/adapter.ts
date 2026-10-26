import pkg from '@slack/bolt'
import type { Config } from '../../config.ts'
import type { Core } from '../../core/core.ts'
import { errorMessage } from '../../core/errors.ts'
import type { Inbound, Rooms } from '../../core/types.ts'
import { redact } from '../../storage/redact.ts'
import { SlackAccess } from './access.ts'
import { SlackActivities } from './activities.ts'
import type { SlackApi } from './api.ts'
import { SlackConnection } from './connection.ts'
import { gatherHistory, readSlackFile } from './history.ts'
import { createIdentityResolver } from './identity.ts'
import { slackImageLoader } from './images.ts'
import { SlackOutput } from './output.ts'
import { createRoomApi } from './rooms.ts'
import { accepts, conversationRoute, type SlackRoute } from './routing.ts'
import { messageBody } from './thread.ts'

/**
 * Turns Slack events into Inbound messages for the core. It is wired to a Core on start, since
 * the core needs the bot's own identity, which only `auth.test` can tell.
 */
class SlackInbound {
  botId = ''
  private readonly config: Config
  private readonly api: SlackApi
  private readonly output: SlackOutput
  private core!: Core
  private access!: SlackAccess

  constructor(config: Config, api: SlackApi, output: SlackOutput) {
    this.config = config
    this.api = api
    this.output = output
  }

  private get team(): string {
    return this.config.slack.workspace_team_id
  }

  async start(core: Core, rooms: Rooms): Promise<void> {
    const { api, team } = this
    this.core = core
    this.access = new SlackAccess(core.access, team, async (author) => {
      return (await api('users.info', { user: author })).user
    })
    this.output.store = core.store
    this.output.activities = new SlackActivities(
      api,
      core.store,
      this.config.slack.progress_mode === 'plain',
    )
    core.rooms = rooms
    const auth = await api('auth.test', {})
    if (auth.team_id !== team) throw new Error('El token Slack pertenece a otro workspace.')
    this.botId = auth.user_id
    const token = process.env.SLACK_BOT_TOKEN!
    core.historyLoader = (source, signal, includeOwn) =>
      gatherHistory(
        api,
        source,
        this.botId,
        (file) => readSlackFile(file, token),
        signal,
        includeOwn,
      )
    core.identities = createIdentityResolver(api, team)
    core.imageLoader = slackImageLoader(api, token)
  }

  /** A message or app_mention event. */
  async message(event: any, body: any, mention = false): Promise<void> {
    if (this.ignores(event)) return
    const route = conversationRoute(this.core.store, event)
    const mentionTag = `<@${this.botId}>`
    // app_mention and message may have different event IDs for the same message.
    if (!mention && !route.dm && (event.text ?? '').includes(mentionTag)) return
    const text = messageBody(event).replaceAll(mentionTag, '').trim()
    const conversation = this.core.store.conversation(route.key)
    if (!accepts({ dm: route.dm, mention, author: event.user, text, conversation })) return

    const input = this.inbound(event, body, route, text || 'Revisa el contexto de este hilo.')
    if (!this.core.authorized(input)) return
    if (!(await this.access.allowed(event.user))) return
    // The route can change while access is checked: a room transfer may have landed.
    const { redirect, pending } = conversationRoute(this.core.store, event)

    if (pending) {
      return this.reply(
        event,
        'El traslado aun no termina. Continua en la conversacion de origen hasta que se confirme la sala.',
      )
    }

    if (redirect) return this.reply(event, `Continuamos en <#${redirect}>.`)
    this.output.latestThread.set(route.key, event.thread_ts ?? event.ts)

    try {
      await this.core.submit(input)
    } catch (error) {
      await this.reply(event, `No pude procesar el mensaje: ${redact(errorMessage(error))}`)
    }
  }

  /** The user pressed "stop" on the native agent session: treat it as the stop command. */
  async sessionStopped(event: any, body: any): Promise<void> {
    if (!event.thread_ts && !event.ts) return
    const { key, thread } = conversationRoute(this.core.store, event)
    const input: Inbound = {
      adapter: 'slack',
      key,
      eventId: body.event_id,
      channel: event.channel,
      thread,
      team: body.team_id,
      author: event.user,
      text: 'stop',
    }

    if (!this.core.authorized(input) || !(await this.access.allowed(event.user))) return
    if (this.core.store.conversation(key)?.channel !== event.channel) return
    await this.core.submit(input)
  }

  /** A button press on a regent_ask_human question. */
  async answer(body: any, action: any): Promise<string> {
    if (body.user?.team_id && body.user.team_id !== this.team) {
      throw new Error('Usuario de otro workspace.')
    }

    if (!(await this.access.allowed(body.user.id))) {
      throw new Error('Usuario fuera de la configuracion autorizada.')
    }

    const result = await this.core.answerQuestion(
      action.value,
      Number(action.action_id.replace('regent_question_', '')),
      body.user.id,
      body.team?.id,
      body.channel?.id,
      body.message?.thread_ts ?? null,
    )

    return result.duplicate ? 'La pregunta ya fue respondida.' : 'Respuesta registrada.'
  }

  /** Bot posts, edits, joins and foreign-workspace users never start a run. */
  private ignores(event: any): boolean {
    if (event.bot_id || event.user === this.botId || !event.user || !event.ts) return true
    if (event.subtype && event.subtype !== 'file_share') return true
    return Boolean(event.user_team && event.user_team !== this.team)
  }

  private inbound(event: any, body: any, route: SlackRoute, text: string): Inbound {
    return {
      adapter: 'slack',
      eventId: `message:${event.channel}:${event.ts}`,
      key: route.key,
      channel: event.channel,
      thread: route.thread,
      replyThread: event.thread_ts ?? (route.room ? undefined : event.ts),
      team: body.team_id,
      author: event.user,
      text,
      history: {
        channel: event.channel,
        thread: route.historyThread,
        latest: event.ts,
        trigger: `${event.channel}:${event.ts}`,
      },
    }
  }

  private async reply(event: any, text: string): Promise<void> {
    await this.api('chat.postMessage', {
      channel: event.channel,
      thread_ts: event.thread_ts ?? event.ts,
      text,
    })
  }
}

export function createSlack(config: Config) {
  const receiver = new pkg.SocketModeReceiver({
    appToken: process.env.SLACK_APP_TOKEN ?? '',
    autoReconnectEnabled: false,
  })
  const app = new pkg.App({
    token: process.env.SLACK_BOT_TOKEN,
    receiver,
    clientOptions: { timeout: 10000, retryConfig: { retries: 2 } },
  })

  const api: SlackApi = async (method, args) => {
    const response = await app.client.apiCall(method, args)
    if (!response.ok) throw new Error(`${method}: Slack rejected the request`)
    return response
  }

  const output = new SlackOutput(api)
  const inbound = new SlackInbound(config, api, output)
  const rooms = createRoomApi(api, config.slack.workspace_team_id, () => inbound.botId)
  const connection = new SlackConnection(receiver.client, (message) =>
    console.warn(`[slack v2] ${redact(message)}`),
  )

  app.event('app_mention', ({ event, body }) => inbound.message(event, body, true))
  app.message(({ message, body }) => inbound.message(message, body))
  app.event('agent_session_stopped' as any, ({ event, body }: any) =>
    inbound.sessionStopped(event, body),
  )
  app.action(/^regent_question_([0-4])$/, async ({ ack, body, action, respond }: any) => {
    await ack()
    let text: string

    try {
      text = await inbound.answer(body, action)
    } catch (error) {
      text = redact(errorMessage(error))
    }

    await respond({ text, replace_original: false, response_type: 'ephemeral' })
  })
  app.error(async (error) => {
    console.error(`[slack v2] ${redact(error.message)}`)
  })

  return {
    output,
    rooms,
    connected: () => connection.connected,
    async start(core: Core) {
      await inbound.start(core, rooms)
      await connection.start(() => app.start())
    },
    async stop() {
      await connection.stop(() => app.stop())
    },
  }
}
