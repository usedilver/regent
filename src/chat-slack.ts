/**
 * Adaptador de Slack — patrón "Slack Code": una sala efímera por card.
 *
 *   #task-<id>  ← se crea cuando un agente arranca sobre el card
 *      · cada rol firma con su username+emoji (chat:write.customize — 1 app, N caras)
 *      · los comentarios del bot en Notion se espejan aquí (el registro sigue en Notion)
 *      · @rol en la sala = mismo router de menciones que en Notion
 *      · texto plano con agente vivo = intervención directa al pane (herdr/tmux)
 *      · "stop" = interrumpir al agente
 *      · card a estado terminal → sala archivada
 *
 * Socket Mode: WebSocket saliente — sin URL pública para esta pata.
 */
import pkg from '@slack/bolt'
import type { ChatAdapter, ChatConfig, ChatHandlers, ChatPersona } from './chat.ts'
import { loadRooms, saveRoom, roomOf } from './chat.ts'
import { csvEnvOr } from './bridge-config.ts'

const { App } = pkg

export function createSlackAdapter(cfg: ChatConfig): ChatAdapter {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
  })
  // a quién invitar sale de workflow.json (chat.invite_users); la env queda de override
  const inviteUsers = csvEnvOr('SLACK_INVITE_USERS', cfg.invite_users)

  // nombres legibles: <@U123> → @Dilver (cache en memoria; sin users:read se queda el id)
  const userNames = new Map<string, string>()
  const nameOf = async (id: string): Promise<string> => {
    if (userNames.has(id)) return userNames.get(id)!
    let name = id
    try {
      const res = await app.client.users.info({ user: id })
      name = res.user?.profile?.display_name || res.user?.real_name || res.user?.name || id
    } catch { /* sin scope users:read */ }
    userNames.set(id, name)
    return name
  }
  const humanize = async (text: string): Promise<string> => {
    const ids = [...new Set([...text.matchAll(/<@([A-Z0-9]+)>/g)].map(m => m[1]))]
    let out = text
    for (const id of ids) out = out.replaceAll(`<@${id}>`, `@${await nameOf(id)}`)
    return out
  }

  const channelToPage = (): Record<string, string> =>
    Object.fromEntries(Object.entries(loadRooms()).map(([page, r]) => [r.channelId, page]))

  // ---- caras REALES por rol: apps de identidad SIN proceso (setup-slack-roles.ts) ----
  // El hub escucha (este socket); las caras solo hablan con su token (chat:write).
  const envKeyForRole = (role: string) => `SLACK_BOT_TOKEN_${role.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
  const roleTokens = new Map<string, string>()
  for (const role of Object.keys(cfg.role_mentions)) {
    const t = process.env[envKeyForRole(role)]
    if (t) roleTokens.set(role, t)
  }
  const roleByUserId = new Map<string, string>() // bot user id de la cara → rol
  const slackFetch = async (method: string, token: string, body: Record<string, unknown> = {}) => {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json() as { ok: boolean; error?: string } & Record<string, unknown>
    if (!json.ok) throw new Error(`${method} → ${json.error}`)
    return json
  }
  /** mención REAL a una cara (<@U_rol>) → alias del router ("@pm"); el resto queda igual */
  const translateRoleMentions = (text: string): string =>
    text.replace(/<@([A-Z0-9]+)>/g, (m, id: string) => {
      const role = roleByUserId.get(id)
      return role ? (cfg.role_mentions[role] ?? `@${role}`) : m
    })
  /** hilo completo → transcript legible + participantes humanos */
  const gatherThread = async (channel: string, threadTs: string): Promise<{ transcript?: string; participants?: string[] }> => {
    try {
      const replies = await app.client.conversations.replies({ channel, ts: threadTs, limit: 50 })
      const msgs = (replies.messages ?? []).filter(m => !(m as { bot_id?: string }).bot_id && m.text)
      const transcript = (await Promise.all(msgs.map(async m => `@${await nameOf(m.user ?? 'unknown')}: ${await humanize(m.text!)}`))).join('\n')
      const participants = [...new Set(msgs.map(m => m.user!).filter(Boolean))]
      return { transcript: transcript || undefined, participants: participants.length ? participants : undefined }
    } catch { return {} } // sin *:history en ese canal: seguimos solo con el mensaje
  }

  return {
    name: 'slack',

    async start(handlers: ChatHandlers) {
      // qué bot user es cada cara — habilita traducir menciones reales e invitarlas a salas
      for (const [role, token] of roleTokens) {
        try {
          const who = await slackFetch('auth.test', token)
          roleByUserId.set(who.user_id as string, role)
        } catch (err) { console.warn(`[chat-slack] cara de ${role} inválida: ${(err as Error).message}`) }
      }
      if (roleByUserId.size > 0) console.log(`[chat-slack] caras reales activas: ${[...roleByUserId.values()].join(', ')}`)

      app.message(async ({ message }) => {
        const m = message as { channel: string; channel_type?: string; text?: string; user?: string; bot_id?: string; subtype?: string; ts?: string; thread_ts?: string }
        if (m.bot_id || m.subtype || !m.text) return // ignorar bots (incluidos yo y las caras) y eventos de sistema
        const pageId = channelToPage()[m.channel]
        if (pageId) return handlers.onMessage({ pageId, text: translateRoleMentions(m.text), userId: m.user ?? 'unknown' })
        if (m.channel_type !== 'im') return // canal ajeno: ahí solo manda app_mention
        // DM con el hub (superficie de agente) = otra puerta de intake; cada hilo es una
        // conversación → los follow-ups del hilo caen en su card (threads.json)
        const text = translateRoleMentions(m.text).replace(/<@[A-Z0-9]+>/g, '').trim()
        const { transcript } = m.thread_ts ? await gatherThread(m.channel, m.thread_ts) : {}
        handlers.onBotMention?.({ channelId: m.channel, text, userId: m.user ?? 'unknown', threadTs: m.thread_ts ?? m.ts, transcript, participants: m.user ? [m.user] : undefined })
      })
      // mención al bot fuera de las salas → crear tareas desde cualquier canal.
      // Si la mención está DENTRO de un hilo, se recoge el hilo completo (transcript +
      // participantes) para que el card nazca con todo el contexto.
      app.event('app_mention', async ({ event }) => {
        const e = event as { channel: string; text?: string; user?: string; ts?: string; thread_ts?: string }
        if (channelToPage()[e.channel] || e.channel.startsWith('D')) return // salas y DMs van por app.message
        // menciones reales de caras → alias del router; luego fuera el resto de menciones.
        // Puede quedar VACÍO ("@bot" a secas): igual se reenvía — nunca silencio.
        const text = translateRoleMentions(e.text ?? '').replace(/<@[A-Z0-9]+>/g, '').trim()
        const { transcript, participants } = e.thread_ts ? await gatherThread(e.channel, e.thread_ts) : {}
        handlers.onBotMention?.({ channelId: e.channel, text, userId: e.user ?? 'unknown', threadTs: e.thread_ts ?? e.ts, transcript, participants })
      })
      // panel de agente (agent_view): prompts sugeridos al abrir un hilo con el hub
      app.event('assistant_thread_started', async ({ event }) => {
        const t = (event as { assistant_thread?: { channel_id?: string; thread_ts?: string } }).assistant_thread
        if (!t?.channel_id || !t.thread_ts) return
        try {
          await app.client.assistant.threads.setSuggestedPrompts({
            channel_id: t.channel_id,
            thread_ts: t.thread_ts,
            title: '¿Qué hacemos?',
            prompts: [
              { title: 'Crear una tarea', message: 'Quiero crear una tarea nueva, te paso los detalles.' },
              { title: 'Reportar un bug', message: 'Encontré un bug que quiero reportar.' },
            ],
          })
        } catch { /* superficie opcional: sin assistant:write no pasa nada */ }
      })
      await app.start()
      console.log('[chat-slack] Socket Mode conectado')
    },

    async postTo(channelId: string, text: string, threadTs?: string) {
      await app.client.chat.postMessage({ channel: channelId, text, thread_ts: threadTs, unfurl_links: false })
    },

    // conversación humana de la sala — el digest que va al card antes de archivar.
    // Solo mensajes de PERSONAS: lo de los agentes ya vive en Notion (comentarios/cuerpo).
    async historyOf(pageId: string) {
      const room = roomOf(pageId)
      if (!room?.channelId) return null
      try {
        const res = await app.client.conversations.history({ channel: room.channelId, limit: 200 })
        const msgs = (res.messages ?? [])
          .filter(m => !(m as { bot_id?: string }).bot_id && !(m as { subtype?: string }).subtype && m.text)
          .reverse() // history llega del más nuevo al más viejo
          .slice(-150)
        return await Promise.all(msgs.map(async m => `@${await nameOf((m as { user?: string }).user ?? 'unknown')}: ${await humanize(m.text!)}`))
      } catch { return null }
    },

    // "está trabajando…" nativo del panel de agente; solo aplica en hilos del DM del hub
    async ackWorking(channelId: string, threadTs?: string) {
      if (!channelId.startsWith('D') || !threadTs) return false
      try {
        await app.client.assistant.threads.setStatus({ channel_id: channelId, thread_ts: threadTs, status: 'leyendo el pedido…' })
        return true
      } catch { return false }
    },

    // email del usuario (scope users:read.email) → el server lo mapea a su usuario de Notion (Owner)
    async emailOf(userId: string) {
      try { return (await app.client.users.info({ user: userId })).user?.profile?.email ?? null } catch { return null }
    },

    async ensureRoom(pageId: string, topic?: string) {
      const existing = roomOf(pageId)
      if (existing?.channelId) return existing.channelId
      // nombre legible: task-<slug-del-título>; el id solo aparece si el nombre choca
      const title = existing?.title ?? ''
      const slug = title
        .normalize('NFD').replace(/[̀-ͯ]/g, '') // sin acentos
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
      const base = slug ? `task-${slug}` : `task-${pageId.replace(/-/g, '').slice(-12)}`
      let channelId: string | undefined
      for (const name of [base, `${base}-${pageId.replace(/-/g, '').slice(-6)}`]) {
        try {
          const res = await app.client.conversations.create({ name })
          channelId = res.channel?.id
          break
        } catch (err) {
          if ((err as { data?: { error?: string } }).data?.error !== 'name_taken') throw err
        }
      }
      if (!channelId) return null
      saveRoom(pageId, { channelId })
      if (topic) {
        try { await app.client.conversations.setTopic({ channel: channelId, topic: topic.slice(0, 250) }) } catch { /* opcional */ }
      }
      // invitar: participantes del hilo de origen + lista explícita, o auto-descubrir
      // humanos del workspace (users:read; tope chat.auto_invite_limit, 0 = desactivado)
      let invitees = [...new Set([...(existing?.pendingInvites ?? []), ...inviteUsers])]
      const limit = cfg.auto_invite_limit
      if (invitees.length === 0 && limit > 0) {
        try {
          const res = await app.client.users.list({ limit: 100 })
          const humans = (res.members ?? []).filter(m => !m.is_bot && !m.deleted && m.id !== 'USLACKBOT').map(m => m.id!)
          if (humans.length > 0 && humans.length <= limit) invitees = humans
          else if (humans.length > limit) console.warn(`[chat-slack] ${humans.length} humanos > chat.auto_invite_limit (${limit}) — define chat.invite_users en workflow.json`)
        } catch { console.warn('[chat-slack] auto-invitación requiere el scope users:read (o define chat.invite_users en workflow.json)') }
      }
      invitees = [...new Set([...invitees, ...roleByUserId.keys()])] // las caras siempre entran
      for (const user of invitees) {
        try { await app.client.conversations.invite({ channel: channelId, users: user }) } catch { /* ya dentro */ }
      }
      return channelId
    },

    async post(pageId: string, persona: ChatPersona, text: string) {
      const room = roomOf(pageId)
      if (!room?.channelId) return
      // cara REAL del rol (su propia app) si hay token; customize queda de fallback
      const roleToken = persona.role ? roleTokens.get(persona.role) : undefined
      if (roleToken) {
        try {
          await slackFetch('chat.postMessage', roleToken, { channel: room.channelId, text, unfurl_links: false })
          return
        } catch (err) { console.warn(`[chat-slack] la cara de ${persona.role} no pudo postear (${(err as Error).message}) — fallback customize`) }
      }
      // icon_emoji requiere nombre estilo :robot_face:; los emoji unicode van en el username
      const iconName = persona.emoji && /^[a-z0-9_+-]+$/.test(persona.emoji) ? `:${persona.emoji}:` : undefined
      await app.client.chat.postMessage({
        channel: room.channelId,
        text,
        username: persona.username ?? cfg.name,
        ...(iconName ? { icon_emoji: iconName } : {}),
        unfurl_links: false,
      })
    },

    async archiveRoom(pageId: string, summary: string) {
      const room = roomOf(pageId)
      if (!room?.channelId) return
      try {
        await app.client.chat.postMessage({ channel: room.channelId, text: summary, unfurl_links: false })
        await app.client.conversations.archive({ channel: room.channelId })
      } catch (err) {
        console.warn(`[chat-slack] no pude archivar ${room.channelId}: ${(err as Error).message}`)
      }
    },
  }
}
