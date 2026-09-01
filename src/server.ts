/**
 * regent server — endpoint del webhook de Notion.
 *
 * Flujo: verifyWebhookSignature → filtrar page.properties_updated del board →
 * dedup por event.id → anti-loop por authors (+ liberación de lock) → confirmar
 * Status vía API → spawn del launcher con el agent de la columna.
 *
 * Config de instancia: <bridge>/workflow.json + <bridge>/agents/ (defaults).
 * REPO_PATH = carpeta con los repos clonados; la propiedad Repo del card elige
 * cuál (DEFAULT_REPO si falta). El payload del webhook es SPARSE: el webhook es
 * la señal, la API es la verdad.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Client, verifyWebhookSignature } from '@notionhq/client'
import { BRIDGE_DIR, loadEnv } from './env.ts'
import { loadBridge, warnMovedEnv, csvEnvOr } from './bridge-config.ts'
import { findMentionTargets, pageCreatedAgent, evaluateHandoff } from './router.ts'
import { createChatAdapter, saveRoom, roomOf, threadKey, pageOfThread, saveThread, type ChatAdapter } from './chat.ts'
import { runIntake, listRepos, type FillableProp } from './intake.ts'
import { sendToLiveAgent, interruptLiveAgent, closeTab } from './terminal.ts'
import { cleanupCardWorktree } from './git-cleanup.ts'
import { execFile } from 'node:child_process'

loadEnv()

const LOG_DIR = path.join(BRIDGE_DIR, 'log')
fs.mkdirSync(LOG_DIR, { recursive: true })
const ENV_PATH = path.join(BRIDGE_DIR, '.env')

const PORT = Number(process.env.PORT ?? 8787)
const HOST = process.env.HOST ?? '127.0.0.1'
const WEBHOOK_PATH = process.env.WEBHOOK_PATH ?? '/notion-webhook'
const DATABASE_ID = normalizeId(process.env.DATABASE_ID)
const DATA_SOURCE_ID = normalizeId(process.env.DATA_SOURCE_ID)
const LAUNCHER = process.env.LAUNCHER // override para tests; default: launcher.ts
const LAUNCHER_TS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'launcher.ts')

const bridge = loadBridge()
let chat: ChatAdapter // se inicializa en el arranque (slack si hay tokens; noop si no)
let verificationToken: string | null = process.env.NOTION_VERIFICATION_TOKEN || null

const personaOf = (agentName?: string) =>
  agentName ? { ...(bridge.config.agents[agentName]?.chat ?? {}), role: agentName } : { username: bridge.config.name }
const cardUrl = (pageId: string) => `https://notion.so/${pageId.replace(/-/g, '')}`

function normalizeId(id?: string): string | null {
  return (id ?? '').replace(/-/g, '').toLowerCase() || null
}

// ---- log JSONL ----
const EVENTS_LOG = path.join(LOG_DIR, 'events.jsonl')
function jlog(kind: string, fields: Record<string, unknown> = {}): void {
  const entry = { ts: new Date().toISOString(), kind, ...fields }
  fs.appendFileSync(EVENTS_LOG, JSON.stringify(entry) + '\n')
  console.log(`[${entry.ts}] ${kind}`, JSON.stringify(fields))
}

// ---- rotación del log: crece sin límite y se lee entero al arrancar (seed del dedup).
// Las ventanas de dedup relevantes son cortas (reintentos de Notion = horas), así que
// bastan las últimas líneas; el resto se archiva.
const LOG_MAX_BYTES = Number(process.env.EVENTS_LOG_MAX_MB ?? 5) * 1024 * 1024
if (fs.existsSync(EVENTS_LOG) && fs.statSync(EVENTS_LOG).size > LOG_MAX_BYTES) {
  const lines = fs.readFileSync(EVENTS_LOG, 'utf8').trimEnd().split('\n')
  const keep = lines.slice(-2000)
  const archive = path.join(LOG_DIR, `events-${new Date().toISOString().slice(0, 10)}-${Date.now()}.jsonl`)
  fs.writeFileSync(archive, lines.slice(0, -2000).join('\n') + '\n')
  fs.writeFileSync(EVENTS_LOG, keep.join('\n') + '\n')
  console.log(`log rotado: ${lines.length - 2000} líneas → ${path.basename(archive)}`)
}

// ---- estado ----
const seenEvents = new Set<string>()
const inFlightPages = new Set<string>()

if (fs.existsSync(EVENTS_LOG)) {
  for (const line of fs.readFileSync(EVENTS_LOG, 'utf8').split('\n')) {
    try {
      const e = JSON.parse(line)
      if (e.kind === 'event_received' && e.event_id) seenEvents.add(e.event_id)
    } catch { /* línea corrupta */ }
  }
}

// ---- anti-loop: bot user id ----
let botUserId: string | null = null
const notion = process.env.NOTION_TOKEN ? new Client({ auth: process.env.NOTION_TOKEN }) : null
async function fetchBotUserId(): Promise<void> {
  if (!notion) {
    console.warn('⚠️  NOTION_TOKEN no configurado: anti-loop y confirmación de Status deshabilitados.')
    return
  }
  try {
    const me = await notion.users.me({})
    botUserId = me.id
    jlog('startup_whoami', { bot_user_id: botUserId, name: (me as { name?: string }).name })
  } catch (err) {
    console.warn(`⚠️  users.me falló (${(err as Error).message}); anti-loop deshabilitado.`)
  }
}

// ---- verification token (primera entrega, sin firmar, UNA sola vez) ----
function persistVerificationToken(token: string): void {
  const tokenFile = path.join(LOG_DIR, 'verification_token.txt')
  fs.writeFileSync(tokenFile, token + '\n', { mode: 0o600 })
  let env = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : ''
  if (/^NOTION_VERIFICATION_TOKEN=\s*["']?[^"'\s]/m.test(env)) {
    console.warn('⚠️  .env ya tiene NOTION_VERIFICATION_TOKEN; el nuevo quedó SOLO en log/verification_token.txt')
  } else if (/^NOTION_VERIFICATION_TOKEN=/m.test(env)) {
    env = env.replace(/^NOTION_VERIFICATION_TOKEN=.*$/m, `NOTION_VERIFICATION_TOKEN="${token}"`)
    fs.writeFileSync(ENV_PATH, env)
  } else {
    fs.appendFileSync(ENV_PATH, `\nNOTION_VERIFICATION_TOKEN="${token}"\n`)
  }
  verificationToken = token
  jlog('verification_token_received', { token_masked: token.slice(0, 12) + '…' })
  console.log(`\n🔑 Verification token guardado en ${tokenFile} y .env — pégalo en el botón Verify de Notion.\n`)
}

// ---- tipos mínimos del payload sparse ----
interface NotionEvent {
  id?: string
  type?: string
  timestamp?: string
  attempt_number?: number
  entity?: { id?: string; type?: string }
  authors?: Array<{ id: string }>
  data?: { parent?: { id?: string; type?: string }; page_id?: string }
  verification_token?: string
}

/**
 * Frescura: menciones y creaciones más viejas que N minutos se descartan.
 * Protege contra la avalancha de reintentos de Notion al despertar la máquina
 * (un laptop suspendido acumula entregas de horas). Las transiciones de columna
 * no lo necesitan: se confirman contra el Status ACTUAL vía API.
 */
const FRESHNESS_MIN = Number(process.env.EVENT_FRESHNESS_MINUTES ?? 30)
function isStale(event: NotionEvent): boolean {
  if (!event.timestamp) return false
  const age = Date.now() - Date.parse(event.timestamp)
  return Number.isFinite(age) && age > FRESHNESS_MIN * 60 * 1000
}

// dedup adicional por comment id (un mismo comentario jamás relanza, ni con event id distinto)
const processedComments = new Set<string>()
if (fs.existsSync(EVENTS_LOG)) {
  for (const line of fs.readFileSync(EVENTS_LOG, 'utf8').split('\n')) {
    try {
      const e = JSON.parse(line)
      if ((e.kind === 'mention_human' || e.kind === 'handoff') && e.comment_id) processedComments.add(e.comment_id)
    } catch { /* línea corrupta */ }
  }
}

type PageProps = Record<string, { type?: string; select?: { name?: string } | null; status?: { name?: string } | null; checkbox?: boolean; number?: number | null }>

async function currentStatus(pageId: string): Promise<{ statusName?: string; props?: PageProps; parentDb?: string | null }> {
  const page = await notion!.pages.retrieve({ page_id: pageId }) as {
    properties: PageProps
    parent?: { database_id?: string; data_source_id?: string }
  }
  const props = page.properties
  const statusProp = props[bridge.config.status_property]
    ?? Object.values(props).find(p => p.type === 'status')
  const parentDb = normalizeId(page.parent?.database_id ?? page.parent?.data_source_id ?? undefined)
  return { statusName: statusProp?.status?.name, props, parentDb }
}

function belongsToBoard(parentDb?: string | null): boolean {
  if (!parentDb || (!DATABASE_ID && !DATA_SOURCE_ID)) return true
  return parentDb === DATABASE_ID || parentDb === DATA_SOURCE_ID
}

// ---- cola de triggers in-flight: tamaño 1 por card, "la última señal gana" ----

interface QueuedTrigger {
  agent: string
  extraArgs: string[]
  lockReason: string
  /** para triggers de columna: el estado que debe seguir vigente al ejecutar */
  column?: string
  queuedAt: string
}

const QUEUE_FILE = path.join(LOG_DIR, 'queue.json')
const QUEUE_MAX_AGE_MIN = Number(process.env.QUEUE_MAX_AGE_MINUTES ?? 15)

function loadQueue(): Record<string, QueuedTrigger> {
  try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')) } catch { return {} }
}
function saveQueue(q: Record<string, QueuedTrigger>): void {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2))
}

/** Encola (pisando lo anterior) un trigger que llegó con el card ocupado. */
function enqueueTrigger(pageId: string, t: Omit<QueuedTrigger, 'queuedAt'>): void {
  const q = loadQueue()
  q[pageId] = { ...t, queuedAt: new Date().toISOString() }
  saveQueue(q)
  jlog('trigger_queued', { page_id: pageId, agent: t.agent, reason: t.lockReason })
  void chat.post(pageId, {}, `⏳ hay un agente trabajando — tu orden (${t.agent}) quedó en cola y corre al liberarse.`).catch(() => {})
}

/** Al liberarse el lock de un card: ejecutar su pendiente si sigue fresco y vigente. */
async function processQueued(pageId: string): Promise<void> {
  const q = loadQueue()
  const t = q[pageId]
  if (!t) return
  delete q[pageId]
  saveQueue(q)

  const ageMin = (Date.now() - Date.parse(t.queuedAt)) / 60000
  if (ageMin > QUEUE_MAX_AGE_MIN) {
    jlog('queued_dropped', { page_id: pageId, agent: t.agent, reason: `frescura (${Math.round(ageMin)} min)` })
    void chat.post(pageId, {}, `🗑️ la orden en cola (${t.agent}) llevaba ${Math.round(ageMin)} min — descartada; re-actívala si sigue vigente.`).catch(() => {})
    return
  }
  // trigger de columna: el webhook fue la señal, la API es la verdad — ¿sigue ahí?
  if (t.column && notion) {
    try {
      const { statusName } = await currentStatus(pageId)
      if (statusName !== t.column) {
        return void jlog('queued_dropped', { page_id: pageId, agent: t.agent, reason: `el card ya no está en "${t.column}" (está en "${statusName}")` })
      }
    } catch { /* si no se puede confirmar, mejor no lanzar */ return }
  }
  jlog('queued_executed', { page_id: pageId, agent: t.agent })
  launch(pageId, t.agent, t.extraArgs, t.lockReason)
}

/** Lanza el launcher para un card (fire-and-forget) con lock + TTL + sala de chat. */
function launch(pageId: string, agentName: string, extraArgs: string[], lockReason: string): void {
  inFlightPages.add(pageId)
  const shortId = pageId.replace(/-/g, '').slice(-12)
  // sala efímera: se crea al primer lanzamiento; label para intervención posterior
  saveRoom(pageId, { label: `${agentName}-${shortId}`, agent: agentName })
  void (async () => {
    try {
      // título para el nombre legible de la sala (#task-<slug>)
      if (!roomOf(pageId)?.title && notion) {
        try {
          const page = await notion.pages.retrieve({ page_id: pageId }) as { properties: Record<string, { type?: string; title?: Array<{ plain_text?: string }> }> }
          const t = Object.values(page.properties).find(p => p.type === 'title')?.title?.map(x => x.plain_text ?? '').join('')
          if (t) saveRoom(pageId, { title: t })
        } catch { /* sala con id de fallback */ }
      }
      const created = await chat.ensureRoom(pageId, cardUrl(pageId))
      if (created) await chat.post(pageId, personaOf(agentName), `🤖 arrancando (${lockReason}) · card: ${cardUrl(pageId)}`)
    } catch (err) { jlog('chat_error', { page_id: pageId, error: (err as Error).message }) }
  })()
  const agentLog = path.join(LOG_DIR, `launch-${agentName}-${shortId}-${Date.now()}.log`)
  const out = fs.openSync(agentLog, 'a')
  const [cmd, baseArgs] = LAUNCHER ? [LAUNCHER, [] as string[]] : [process.execPath, [LAUNCHER_TS]]
  const child = spawn(cmd, [...baseArgs, pageId, agentName, ...extraArgs], {
    cwd: BRIDGE_DIR, detached: true, stdio: ['ignore', out, out], env: process.env,
  })
  jlog('agent_launched', { page_id: pageId, trigger: agentName, mode: lockReason, pid: child.pid, log: agentLog })
  const release = (reason: string) => () => {
    if (inFlightPages.delete(pageId)) {
      jlog('release_in_flight', { page_id: pageId, reason })
      void processQueued(pageId)
    }
  }
  child.on('exit', code => {
    jlog('launcher_exited', { page_id: pageId, code })
    if (code !== 0) release('launcher abortó')()
  })
  child.on('error', err => { jlog('agent_spawn_error', { page_id: pageId, error: err.message }); release('spawn error')() })
  setTimeout(release('ttl 30min'), 30 * 60 * 1000).unref()
  child.unref()
}

/** comment.created — menciones humanas (hop 0) y handoffs bot→agent (hop+1, can_trigger). */
async function handleComment(event: NotionEvent): Promise<void> {
  const eventId = event.id
  const pageId = event.data?.page_id ?? event.data?.parent?.id
  if (!pageId || !notion) return void jlog('skip_comment_no_page', { event_id: eventId })
  if (isStale(event)) return void jlog('skip_stale', { event_id: eventId, page_id: pageId, ts: event.timestamp, max_min: FRESHNESS_MIN })
  const commentId = event.entity?.id
  if (commentId && processedComments.has(commentId)) {
    return void jlog('skip_duplicate_comment', { event_id: eventId, comment_id: commentId })
  }

  // texto del comentario (payload sparse → API)
  let text = ''
  try {
    let cursor: string | undefined
    do {
      const res = await notion.comments.list({ block_id: pageId, page_size: 100, start_cursor: cursor }) as {
        results: Array<{ id: string; rich_text: Array<{ plain_text?: string }> }>
        has_more: boolean; next_cursor: string | null
      }
      const found = res.results.find(c => c.id === event.entity?.id)
      if (found) { text = found.rich_text.map(t => t.plain_text ?? '').join(''); break }
      cursor = res.has_more ? res.next_cursor ?? undefined : undefined
    } while (cursor)
  } catch (err) {
    return void jlog('error_comment_fetch', { event_id: eventId, page_id: pageId, error: (err as Error).message })
  }

  const targets = findMentionTargets(text, bridge.config)
  const authors = event.authors ?? []
  const isBot = Boolean(botUserId) && authors.length > 0 && authors.every(a => a.id === botUserId)

  // espejo a la sala: comentarios del bot = progreso del agente; comentarios humanos
  // también se espejan (quien mira la sala ve la conversación completa de Notion)
  if (roomOf(pageId)?.channelId) {
    const persona = isBot ? personaOf(roomOf(pageId)?.agent) : { username: 'Notion 💬' }
    void chat.post(pageId, persona, text).catch(() => { /* sala archivada */ })
  }

  if (targets.length === 0) {
    // comentario del agente sin handoff = su "respuesta" → libera el lock. Es la
    // única vía para fases con agent_stays (no hay movimiento que detectar), así
    // que comment.created es OBLIGATORIO en la suscripción si usas alguna.
    if (isBot && inFlightPages.delete(pageId)) {
      jlog('release_in_flight', { page_id: pageId, reason: 'respuesta del agente (comment)' })
      void processQueued(pageId)
    }
    return void jlog(isBot ? 'skip_own_comment' : 'skip_comment_no_mention', { event_id: eventId, page_id: pageId })
  }
  const target = targets[0]
  if (targets.length > 1) jlog('mention_extra_targets_ignored', { event_id: eventId, ignored: targets.slice(1) })

  // pertenencia al board + props para hop/agente
  let props: PageProps | undefined, parentDb: string | null | undefined
  try { ({ props, parentDb } = await currentStatus(pageId)) } catch (err) {
    return void jlog('error_confirm', { event_id: eventId, page_id: pageId, error: (err as Error).message })
  }
  if (!belongsToBoard(parentDb)) return void jlog('skip_other_parent', { event_id: eventId, parent: parentDb })

  const commentB64 = Buffer.from(text).toString('base64')
  if (commentId) processedComments.add(commentId)

  if (!isBot) {
    if (inFlightPages.has(pageId)) {
      // card ocupado → a la cola (la última señal gana)
      return enqueueTrigger(pageId, { agent: target, extraArgs: ['--mode', 'mention', '--hop', '0', '--comment-b64', commentB64], lockReason: 'mention' })
    }
    jlog('mention_human', { event_id: eventId, page_id: pageId, target, comment_id: commentId })
    return launch(pageId, target, ['--mode', 'mention', '--hop', '0', '--comment-b64', commentB64], 'mention')
  }

  // handoff bot→agent: el comentario con mención ES la respuesta final del agente
  // origen → liberar su lock primero (si no, el handoff quedaría atascado hasta el TTL)
  if (inFlightPages.delete(pageId)) jlog('release_in_flight', { page_id: pageId, reason: 'handoff emitido por el agente' })
  const agentProp = bridge.config.agent_property
  const hopProp = bridge.config.hop_property
  const sourceAgent = agentProp ? props?.[agentProp]?.select?.name : undefined
  const currentHops = (hopProp ? props?.[hopProp]?.number : 0) ?? 0
  const verdict = evaluateHandoff(sourceAgent, target, currentHops, bridge.config)
  if (!verdict.ok) {
    jlog('skip_handoff_denied', { event_id: eventId, page_id: pageId, source: sourceAgent, target, reason: verdict.reason })
    return void processQueued(pageId) // el lock quedó libre: atender pendientes
  }
  jlog('handoff', { event_id: eventId, page_id: pageId, source: sourceAgent, target, hop: verdict.nextHop, comment_id: commentId })
  launch(pageId, target, ['--mode', 'mention', '--hop', String(verdict.nextHop), '--comment-b64', commentB64], 'handoff')
}

/** page.created — rol triage sobre cards nuevos (creados por humanos). */
async function handleCreated(event: NotionEvent): Promise<void> {
  const eventId = event.id
  const pageId = event.entity?.id
  if (!pageId) return void jlog('skip_created_no_page', { event_id: eventId })
  if (isStale(event)) return void jlog('skip_stale', { event_id: eventId, page_id: pageId, ts: event.timestamp, max_min: FRESHNESS_MIN })

  const authors = event.authors ?? []
  const isBot = Boolean(botUserId) && authors.length > 0 && authors.every(a => a.id === botUserId)
  if (isBot) return void jlog('skip_created_by_bot', { event_id: eventId, page_id: pageId })

  const parentId = normalizeId(event.data?.parent?.id)
  if (parentId && !belongsToBoard(parentId)) return void jlog('skip_other_parent', { event_id: eventId, parent: parentId })

  // triage determinista y SILENCIOSO (el Backlog sigue quieto, ningún agente despierta):
  // el creador del card queda como Owner — lo único del rol triage retirado que valía conservar
  const creator = authors[0]?.id
  if (creator && bridge.config.owner_property && notion) {
    try {
      await notion.pages.update({ page_id: pageId, properties: { [bridge.config.owner_property]: { people: [{ id: creator }] } } } as never)
      jlog('created_owner_set', { page_id: pageId, owner: creator })
    } catch (err) { jlog('created_owner_error', { page_id: pageId, error: (err as Error).message }) } // creador invitado/sin permiso: queda sin Owner
  }

  const agentName = pageCreatedAgent(bridge.config)
  if (!agentName) return void jlog('skip_created_no_agent', { event_id: eventId })

  const args = ['--mode', 'created', '--hop', '0']
  if (authors[0]?.id) args.push('--creator', authors[0].id)
  if (inFlightPages.has(pageId)) {
    return enqueueTrigger(pageId, { agent: agentName, extraArgs: args, lockReason: 'created' })
  }
  jlog('page_created', { event_id: eventId, page_id: pageId, agent: agentName })
  launch(pageId, agentName, args, 'created')
}

// ---- procesamiento (después del ACK) ----
async function processEvent(event: NotionEvent): Promise<void> {
  const eventId = event.id
  const pageId = event.entity?.id
  const attempt = event.attempt_number ?? 1

  if (eventId && seenEvents.has(eventId)) return void jlog('skip_duplicate', { event_id: eventId, attempt })
  if (eventId) seenEvents.add(eventId)
  jlog('event_received', { event_id: eventId, type: event.type, page_id: pageId, attempt })

  if (event.type === 'comment.created') return handleComment(event)
  if (event.type === 'page.created') return handleCreated(event)
  if (event.type !== 'page.properties_updated') return void jlog('skip_type', { event_id: eventId, type: event.type })
  if (!pageId) return void jlog('skip_no_entity', { event_id: eventId })

  const parentId = normalizeId(event.data?.parent?.id)
  if (parentId && DATABASE_ID && parentId !== DATABASE_ID && parentId !== DATA_SOURCE_ID) {
    return void jlog('skip_other_parent', { event_id: eventId, parent: parentId })
  }

  // anti-loop: ecos de nuestras escrituras. Si el card estaba en vuelo, el eco
  // sirve para detectar que el agente ya lo movió → liberar lock (+ cola) y
  // manejar terminal (el poller de PRs también mueve cards como bot).
  const authors = event.authors ?? []
  if (botUserId && authors.length > 0 && authors.every(a => a.id === botUserId)) {
    if (notion) {
      try {
        const { statusName, props } = await currentStatus(pageId)
        const echoState = statusName ? bridge.stateByName[statusName] : undefined
        if (echoState?.terminal) handleTerminal(pageId, statusName)
        else if (statusName && roomOf(pageId)?.channelId) {
          // el agente movió el card: el MOVIMIENTO es la señal — el pipeline la publica
          // en la sala (determinista), el agente ya no comenta veredictos de éxito
          const pr = (props?.[bridge.config.pr_property] as { url?: string | null } | undefined)?.url
          void chat.post(pageId, {}, `📍 Card → **${statusName}**${pr ? ` · PR: ${pr}` : ''} · ${cardUrl(pageId)}`).catch(() => {})
        }
        if (inFlightPages.has(pageId) && !echoState?.trigger) {
          inFlightPages.delete(pageId)
          jlog('release_in_flight', { page_id: pageId, reason: 'agente movió el card', status: statusName })
          void processQueued(pageId)
        }
      } catch { /* siguiente evento o TTL */ }
    }
    return void jlog('skip_own_echo', { event_id: eventId, page_id: pageId })
  }

  // el webhook es la señal, la API es la verdad
  if (!notion) return void jlog('skip_no_token', { event_id: eventId })
  let statusName: string | undefined, props: Awaited<ReturnType<typeof currentStatus>>['props']
  try {
    ({ statusName, props } = await currentStatus(pageId))
  } catch (err) {
    return void jlog('error_confirm', { event_id: eventId, page_id: pageId, error: (err as Error).message })
  }

  // tareas humanas: card marcado para NO ejecutarse por agente
  const filter = bridge.config.agent_filter
  if (filter && props) {
    const fp = props[filter.property]
    const fv = fp?.select?.name ?? fp?.status?.name ?? (typeof fp?.checkbox === 'boolean' ? String(fp.checkbox) : null)
    if (fv === filter.skip_value) {
      return void jlog('skip_human_task', { event_id: eventId, page_id: pageId, [filter.property]: fv })
    }
  }

  const state = statusName ? bridge.stateByName[statusName] : undefined
  if (state?.terminal) handleTerminal(pageId, statusName)
  if (!state?.trigger) {
    if (inFlightPages.delete(pageId)) {
      jlog('release_in_flight', { page_id: pageId, reason: 'status sin trigger', status: statusName })
      void processQueued(pageId)
    }
    return void jlog('skip_status', { event_id: eventId, page_id: pageId, status: statusName })
  }

  if (inFlightPages.has(pageId)) {
    // card ocupado → a la cola; al liberarse se re-confirma que siga en esta columna
    return enqueueTrigger(pageId, { agent: state.trigger!, extraArgs: ['--mode', 'column'], lockReason: 'column', column: statusName })
  }
  // disparo fire-and-forget. El lock vive hasta que el card SALGA de la columna
  // trigger (eco del agente o drag humano) o venza el TTL.
  launch(pageId, state.trigger!, ['--mode', 'column'], 'column')
}

/** Card en estado terminal: archivar sala + cerrar tabs + limpiar worktree/rama. */
function handleTerminal(pageId: string, statusName?: string): void {
  const room = roomOf(pageId)
  if (room?.channelId) {
    void (async () => {
      // Notion es el registro: lo hablado por HUMANOS en la sala (que no se espeja en
      // vivo) queda en el card ANTES de archivar — la sala puede morir sin perder nada
      try {
        const lines = (await chat.historyOf?.(pageId)) ?? null
        if (lines?.length) {
          await appendMd(pageId, `## Conversación de la sala (Slack)\n\n${lines.map(l => `> ${l}`).join('\n')}`)
          jlog('room_digest_saved', { page_id: pageId, lines: lines.length })
        }
      } catch (err) { jlog('room_digest_error', { page_id: pageId, error: (err as Error).message }) }
      await chat.archiveRoom(pageId, `✅ Card → **${statusName}** · ${cardUrl(pageId)} — sala archivada.`)
        .catch(err => jlog('chat_error', { page_id: pageId, error: (err as Error).message }))
    })()
  }
  for (const t of room?.tabRefs ?? []) {
    if (closeTab(t)) jlog('tab_closed', { page_id: pageId, tab: t })
  }
  if (room?.tabRefs?.length) saveRoom(pageId, { tabRefs: [] })
  const cleaned = cleanupCardWorktree(pageId)
  if (cleaned.worktree || cleaned.skipped) jlog('worktree_cleanup', { page_id: pageId, ...cleaned })
}

// ---- drift Notion ↔ workflow.json: columnas renombradas/agregadas ----
// Columnas EXTRA en el board son inofensivas (inertes, sin trigger). El peligro real es
// un estado del workflow que ya no existe en el board (trigger muerto en silencio).
async function checkBoardDrift(): Promise<void> {
  if (!notion || !process.env.DATA_SOURCE_ID) return
  try {
    const ds = await notion.dataSources.retrieve({ data_source_id: process.env.DATA_SOURCE_ID }) as {
      properties: Record<string, { status?: { options: Array<{ name: string }> } }>
    }
    const boardStates = new Set((ds.properties[bridge.config.status_property]?.status?.options ?? []).map(o => o.name))
    if (boardStates.size === 0) {
      return void console.warn(`⚠️  drift: la propiedad "${bridge.config.status_property}" no existe en el board (¿renombrada? ¿otro database?)`)
    }
    const missing = bridge.config.states.filter(s => !boardStates.has(s.name))
    const extra = [...boardStates].filter(n => !bridge.stateByName[n])
    for (const s of missing) {
      const sev = s.trigger ? `TRIGGER "${s.name}"→${s.trigger} MUERTO` : `estado "${s.name}" no existe en el board`
      console.warn(`⚠️  drift: ${sev} — ¿columna renombrada? Corrige el board (node src/setup-board.ts --apply) o el workflow.json`)
      jlog('board_drift', { state: s.name, trigger: s.trigger ?? null, kind: 'missing_in_board' })
    }
    if (extra.length) {
      console.log(`ℹ️  columnas del board sin rol en el workflow (inertes, ok): ${extra.join(', ')}`)
    }
    if (!missing.length) console.log('  board ↔ workflow: en sincronía ✓')
  } catch (err) {
    console.warn(`⚠️  drift check falló: ${(err as Error).message}`)
  }
}

// ---- PR mergeado → card a Done (polling con gh: sin webhooks, sin tokens nuevos) ----

const PR_POLL_MIN = Number(process.env.PR_POLL_MINUTES ?? 2)
const prHandled = new Set<string>() // evita repetir mientras Notion propaga el cambio de status

function ghPrState(url: string): Promise<{ state?: string } | null> {
  return new Promise(resolve => {
    execFile('gh', ['pr', 'view', url, '--json', 'state'], { timeout: 20_000 }, (err, stdout) => {
      if (err) return resolve(null)
      try { resolve(JSON.parse(stdout)) } catch { resolve(null) }
    })
  })
}

/** El PR de un card está MERGED (verificado con gh): mover, comentar, cerrar el ciclo. */
async function handleMergedPR(pageId: string, prUrl: string): Promise<void> {
  const moveTo = bridge.config.pr_merged_moves_to
  if (!moveTo || !notion || prHandled.has(pageId)) return
  prHandled.add(pageId)
  jlog('pr_merged', { page_id: pageId, pr: prUrl, move_to: moveTo })
  try {
    await notion.pages.update({
      page_id: pageId,
      properties: { [bridge.config.status_property]: { status: { name: moveTo } } },
    })
    await notion.comments.create({
      parent: { page_id: pageId },
      rich_text: [{ type: 'text', text: { content: `🔀 PR mergeado → ${moveTo}. ${prUrl}` } }],
    })
  } catch (err) {
    jlog('pr_merged_error', { page_id: pageId, error: (err as Error).message })
    prHandled.delete(pageId) // reintento en el próximo tick/evento
    return
  }
  handleTerminal(pageId, moveTo)
}

/** Busca el card cuyo PR sea esta URL (no-terminal). */
async function findCardByPr(prUrl: string): Promise<string | null> {
  if (!notion || !process.env.DATA_SOURCE_ID) return null
  const terminals = bridge.config.states.filter(s => s.terminal).map(s => s.name)
  const res = await notion.dataSources.query({
    data_source_id: process.env.DATA_SOURCE_ID,
    page_size: 10,
    filter: {
      and: [
        { property: bridge.config.pr_property, url: { equals: prUrl } },
        ...terminals.map(t => ({ property: bridge.config.status_property, status: { does_not_equal: t } })),
      ],
    },
  } as never) as { results: Array<{ id: string }> }
  return res.results[0]?.id ?? null
}

async function pollMergedPRs(): Promise<void> {
  const moveTo = bridge.config.pr_merged_moves_to
  if (!moveTo || !notion || !process.env.DATA_SOURCE_ID) return
  const prProp = bridge.config.pr_property
  const terminals = bridge.config.states.filter(s => s.terminal).map(s => s.name)
  try {
    const res = await notion.dataSources.query({
      data_source_id: process.env.DATA_SOURCE_ID,
      page_size: 100,
      filter: {
        and: [
          { property: prProp, url: { is_not_empty: true } },
          ...terminals.map(t => ({ property: bridge.config.status_property, status: { does_not_equal: t } })),
        ],
      },
    } as never) as { results: Array<{ id: string; properties: Record<string, { url?: string | null }> }> }

    for (const page of res.results) {
      const prUrl = page.properties[prProp]?.url
      if (!prUrl || prHandled.has(page.id)) continue
      const pr = await ghPrState(prUrl)
      if (pr?.state === 'MERGED') await handleMergedPR(page.id, prUrl)
    }
  } catch (err) {
    jlog('pr_poll_error', { error: (err as Error).message })
  }
}

// ---- GitHub: merges por EVENTO (en vez de esperar al poll) ----
// Dos vías hacia el mismo endpoint /github-webhook:
//   local:   `gh webhook forward --repo o/r --events pull_request --url http://127.0.0.1:PORT/github-webhook`
//            (sin URL pública; el server puede auto-lanzarlo con GITHUB_FORWARD_REPOS)
//   server:  webhook de repo o GitHub App (manifest de un clic) apuntando al túnel, con secret
// Seguridad: si hay GITHUB_WEBHOOK_SECRET se valida X-Hub-Signature-256; con o sin firma,
// el estado del PR SIEMPRE se re-verifica con gh antes de actuar (señal ≠ verdad).
import crypto from 'node:crypto'

function githubSignatureOk(rawBody: Buffer, header?: string): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET
  if (!secret) return true // sin secret: la verificación con gh es la barrera real
  if (!header?.startsWith('sha256=')) return false
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  try { return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected)) } catch { return false }
}

async function processGithubEvent(eventName: string | undefined, payload: { action?: string; pull_request?: { merged?: boolean; html_url?: string } }): Promise<void> {
  if (eventName !== 'pull_request' || payload.action !== 'closed' || !payload.pull_request?.merged) return
  const prUrl = payload.pull_request.html_url
  if (!prUrl) return
  jlog('github_pr_closed', { pr: prUrl, merged: true })
  const pr = await ghPrState(prUrl) // la verdad: gh confirma el estado
  if (pr?.state !== 'MERGED') return void jlog('github_pr_unverified', { pr: prUrl })
  const pageId = await findCardByPr(prUrl).catch(() => null)
  if (!pageId) return void jlog('github_pr_no_card', { pr: prUrl })
  await handleMergedPR(pageId, prUrl)
}

/** owner/repo de un origin de git (https o ssh) */
function ownerRepoOf(origin: string): string | null {
  const m = origin.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/)
  return m ? `${m[1]}/${m[2]}` : null
}

/**
 * Repos que el BOARD está trabajando: cards no terminales con Repo. Es la fuente de
 * `github.forward_repos: "auto"` — no los clones de REPO_PATH, que incluyen todo lo
 * que el operador tenga en disco (decenas) y levantarían un proceso gh por cada uno.
 */
async function activeBoardRepos(): Promise<string[]> {
  if (!notion || !process.env.DATA_SOURCE_ID) return []
  const repoProp = bridge.config.repo_property
  const terminals = bridge.config.states.filter(s => s.terminal).map(s => s.name)
  try {
    const res = await notion.dataSources.query({
      data_source_id: process.env.DATA_SOURCE_ID,
      page_size: 100,
      filter: {
        and: [
          { property: repoProp, url: { is_not_empty: true } },
          ...terminals.map(t => ({ property: bridge.config.status_property, status: { does_not_equal: t } })),
        ],
      },
    } as never) as { results: Array<{ properties: Record<string, { url?: string | null }> }> }
    return [...new Set(res.results
      .map(p => ownerRepoOf(p.properties[repoProp]?.url ?? ''))
      .filter((r): r is string => Boolean(r)))]
  } catch (err) {
    jlog('forward_auto_error', { error: (err as Error).message })
    return []
  }
}

/** tope de procesos gh simultáneos: pasado eso, el poll de respaldo es más sano */
const MAX_FORWARDERS = 10
const forwarders = new Map<string, { stop: () => void }>()

function startForwarder(repo: string): void {
  let alive = true
  let timer: NodeJS.Timeout | undefined
  let fastExits = 0 // salidas inmediatas seguidas (extensión ausente, permisos, red)
  const spawnFwd = () => {
    if (!alive) return
    const startedAt = Date.now()
    const child = spawn('gh', ['webhook', 'forward', `--repo=${repo}`, '--events=pull_request', `--url=http://127.0.0.1:${PORT}/github-webhook`], { stdio: 'ignore' })
    child.on('exit', code => {
      if (!alive) return
      const ranMs = Date.now() - startedAt
      fastExits = ranMs > 60_000 ? 0 : fastExits + 1
      if (fastExits >= 5) {
        // muere al nacer una y otra vez: rendirse en silencio > spamear el log cada 30s.
        // Queda en el map con stop noop para que el refresh no lo reviva; el próximo
        // arranque del server lo reintenta (p. ej. tras instalar la extensión).
        alive = false
        forwarders.set(repo, { stop: () => { /* ya rendido */ } })
        jlog('gh_forward_gave_up', { repo, code })
        console.warn(`[github] el forward de ${repo} muere al instante (${fastExits} intentos) — lo dejo hasta el próximo arranque del server.`)
        console.warn(`         causa típica: falta la extensión (\`gh extension install cli/gh-webhook\`) o permisos de webhook en el repo. Los merges se detectan igual por el poll de respaldo.`)
        return
      }
      jlog('gh_forward_exit', { repo, code, ran_ms: ranMs, retry_in_s: fastExits >= 3 ? 600 : fastExits === 2 ? 120 : 30 })
      timer = setTimeout(spawnFwd, fastExits >= 3 ? 10 * 60_000 : fastExits === 2 ? 2 * 60_000 : 30_000)
      timer.unref()
    })
    child.unref()
    forwarders.set(repo, { stop: () => { alive = false; clearTimeout(timer); child.kill() } })
  }
  spawnFwd()
  console.log(`  gh-forward: ${repo} → /github-webhook ✓`)
}

/**
 * Arranca/detiene forwarders según la config. Con "auto" se re-evalúa en cada ciclo
 * del poller: un repo nuevo en el board gana su forwarder sin reiniciar el server.
 */
async function refreshGithubForwarders(): Promise<void> {
  const configured = bridge.config.github.forward_repos
  const fromEnv = csvEnvOr('GITHUB_FORWARD_REPOS', [])
  let desired = fromEnv.length ? fromEnv
    : configured === 'auto' ? await activeBoardRepos()
    : configured
  if (desired.length > MAX_FORWARDERS) {
    console.warn(`[github] ${desired.length} repos activos > ${MAX_FORWARDERS} — escucho los primeros; el resto usa el poll (PR_POLL_MINUTES)`)
    desired = desired.slice(0, MAX_FORWARDERS)
  }
  for (const [repo, f] of forwarders) {
    if (!desired.includes(repo)) { f.stop(); forwarders.delete(repo); jlog('gh_forward_stop', { repo }) }
  }
  const added = desired.filter(r => !forwarders.has(r))
  if (added.length) console.log(`[github] forward de PRs (${configured === 'auto' && !fromEnv.length ? 'auto: cards activos' : 'lista fija'}):`)
  for (const repo of added) startForwarder(repo)
}

// ---- HTTP ----
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end('{"status":"ok"}\n')
  }
  if (req.method === 'POST' && req.url === '/github-webhook') {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks)
      if (!githubSignatureOk(rawBody, req.headers['x-hub-signature-256'] as string | undefined)) {
        res.writeHead(401)
        return res.end()
      }
      res.writeHead(202)
      res.end()
      try {
        const payload = JSON.parse(rawBody.toString('utf8'))
        setImmediate(() => void processGithubEvent(req.headers['x-github-event'] as string | undefined, payload).catch(err => jlog('github_error', { error: (err as Error).message })))
      } catch { /* body no-JSON: ignorar */ }
    })
    return
  }
  if (req.method !== 'POST' || req.url !== WEBHOOK_PATH) {
    res.writeHead(404)
    return res.end()
  }

  const chunks: Buffer[] = []
  let size = 0
  req.on('data', (c: Buffer) => {
    size += c.length
    if (size > 1024 * 1024) { res.writeHead(413); res.end(); req.destroy(); return }
    chunks.push(c)
  })
  req.on('end', async () => {
    const rawBody = Buffer.concat(chunks) // bytes exactos: re-serializar rompe la firma
    let body: NotionEvent
    try {
      body = JSON.parse(rawBody.toString('utf8'))
    } catch {
      res.writeHead(400)
      return res.end()
    }

    if (body.verification_token) {
      persistVerificationToken(body.verification_token)
      res.writeHead(200)
      return res.end()
    }

    if (!verificationToken) {
      jlog('reject_no_verification_token', {})
      res.writeHead(503)
      return res.end()
    }
    const signature = req.headers['x-notion-signature'] as string | undefined
    const valid = await verifyWebhookSignature({ body: rawBody, signature, verificationToken })
    if (!valid) {
      jlog('reject_bad_signature', { event_id: body.id })
      res.writeHead(401)
      return res.end()
    }

    res.writeHead(200)
    res.end()
    setImmediate(() => processEvent(body).catch(err => jlog('error_process', { error: (err as Error).message })))
  })
})

/**
 * Mención al bot en cualquier canal → crear un card desde Slack (o follow-up si el
 * hilo ya tiene card). La INTERPRETACIÓN — título real, descripción, inferir repo,
 * rol, respuesta — la hace el agente de intake (claude -p, src/intake.ts); el regex
 * queda solo como fallback si claude no está disponible. La fontanería (card, sala,
 * mapeo hilo→card, locks) sigue siendo determinista.
 */
const NCARD = path.join(BRIDGE_DIR, 'ncard')

function appendMd(pageId: string, md: string): Promise<void> {
  return new Promise(resolve => {
    const child = execFile(NCARD, ['append', pageId, '-'], { env: process.env }, err => {
      if (err) jlog('append_md_error', { page_id: pageId, error: err.message })
      resolve()
    })
    child.stdin?.end(md)
  })
}

const repoFromText = (t: string): string | undefined => {
  const m = t.match(/repo:\s*([\w.-]+\/[\w.-]+)/i) ?? t.match(/github\.com\/([\w.-]+\/[\w.-]+)/i)
  return m ? `https://github.com/${m[1].replace(/[>.,]+$/, '')}` : undefined
}

/** roles para el intake: alias + descripción del agent nativo + columna que lo dispara */
const roleAliases = () => Object.entries(bridge.config.agents).map(([role, a]) => ({
  role,
  mention: (a.triggers?.mentions ?? [])[0] ?? `@${role}`,
  description: bridge.agents.get(role)?.description,
  column: bridge.config.states.find(st => st.trigger === role)?.name,
}))

async function cardSummary(pageId: string): Promise<{ title: string; status: string; repo: string | null }> {
  const page = await notion!.pages.retrieve({ page_id: pageId }) as {
    properties: Record<string, { type?: string; title?: Array<{ plain_text?: string }>; status?: { name?: string }; url?: string | null }>
  }
  const title = Object.values(page.properties).find(p => p.type === 'title')?.title?.map(x => x.plain_text ?? '').join('') ?? ''
  return {
    title,
    status: page.properties[bridge.config.status_property]?.status?.name ?? '',
    repo: page.properties[bridge.config.repo_property]?.url ?? null,
  }
}

// ---- llenar el card al máximo: el intake llena lo que el hilo respalde (esquema
// real del board, sin nombres hardcodeados); Owner y el doc del proyecto salen
// por vías deterministas (email del autor, herencia de otro card del mismo repo).

type DsProp = {
  type: string
  select?: { options: Array<{ name: string }> }
  multi_select?: { options: Array<{ name: string }> }
  relation?: { data_source_id?: string; database_id?: string }
}

async function boardSchema(): Promise<Record<string, DsProp>> {
  const ds = await notion!.dataSources.retrieve({ data_source_id: process.env.DATA_SOURCE_ID! }) as { properties: Record<string, DsProp> }
  return ds.properties
}

/** propiedades que el intake puede llenar: todo tipo escribible que no gestiona el pipeline */
function fillableFrom(schema: Record<string, DsProp>): FillableProp[] {
  // lo que gestiona el pipeline no lo llena el intake
  const c = bridge.config
  const skip = new Set([
    c.status_property, c.pr_property, c.repo_property,
    c.project_doc_property ?? '', c.agent_property ?? '', c.hop_property ?? '', c.progress_property ?? '',
  ])
  const out: FillableProp[] = []
  for (const [name, p] of Object.entries(schema)) {
    if (skip.has(name)) continue
    if (p.type === 'select') out.push({ name, type: 'select', options: p.select?.options.map(o => o.name) ?? [] })
    else if (p.type === 'multi_select') out.push({ name, type: 'multi_select', options: p.multi_select?.options.map(o => o.name) ?? [] })
    else if (p.type === 'number' || p.type === 'date' || p.type === 'checkbox' || p.type === 'rich_text' || p.type === 'url') out.push({ name, type: p.type })
    else if (p.type === 'relation') out.push({ name, type: 'relation', relationTarget: p.relation?.data_source_id ?? p.relation?.database_id })
  }
  return out
}

/** relation: "Sprint 31" → page id en la base relacionada (por título; exacto gana, si no el primero) */
async function findRelatedPage(dataSourceId: string, name: string): Promise<string | null> {
  type Row = { id: string; properties: Record<string, { type?: string; title?: Array<{ plain_text?: string }> }> }
  const titleOf = (r: Row) => Object.values(r.properties).find(pr => pr.type === 'title')?.title?.map(x => x.plain_text ?? '').join('') ?? ''
  try {
    let rows: Row[] = []
    try {
      const res = await notion!.dataSources.query({
        data_source_id: dataSourceId,
        filter: { property: 'title', title: { contains: name } },
        page_size: 10,
      } as never) as { results: Row[] }
      rows = res.results
    } catch {
      // el filtro por id 'title' puede no aplicar en todos los boards → traer y filtrar acá
      const res = await notion!.dataSources.query({ data_source_id: dataSourceId, page_size: 100 } as never) as { results: Row[] }
      rows = res.results.filter(r => titleOf(r).toLowerCase().includes(name.toLowerCase()))
    }
    const exact = rows.find(r => titleOf(r).toLowerCase() === name.toLowerCase())
    return (exact ?? rows[0])?.id ?? null
  } catch { return null }
}

/** intake.properties → payload de Notion validado contra el esquema; las relations se
 *  resuelven por nombre en su base destino. Lo que no se pudo aplicar sale en misses. */
async function resolveProps(values: Record<string, string | number | boolean | string[]>, fillable: FillableProp[]): Promise<{ props: Record<string, unknown>; misses: string[] }> {
  const props: Record<string, unknown> = {}
  const misses: string[] = []
  for (const [name, value] of Object.entries(values)) {
    const def = fillable.find(f => f.name === name)
    if (!def) continue
    switch (def.type) {
      case 'select':
        if (typeof value === 'string' && (!def.options?.length || def.options.includes(value))) props[name] = { select: { name: value } }
        else misses.push(`${name}: "${String(value)}" no es una opción`)
        break
      case 'multi_select': {
        const vals = (Array.isArray(value) ? value : [String(value)]).filter(v => !def.options?.length || def.options!.includes(v))
        if (vals.length > 0) props[name] = { multi_select: vals.map(v => ({ name: v })) }
        break
      }
      case 'number':
        if (typeof value === 'number') props[name] = { number: value }
        break
      case 'checkbox':
        if (typeof value === 'boolean') props[name] = { checkbox: value }
        break
      case 'date':
        if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) props[name] = { date: { start: value } }
        break
      case 'rich_text':
        if (typeof value === 'string' && value) props[name] = { rich_text: [{ text: { content: value.slice(0, 1900) } }] }
        break
      case 'url':
        if (typeof value === 'string' && value) props[name] = { url: value }
        break
      case 'relation': {
        const id = typeof value === 'string' && def.relationTarget ? await findRelatedPage(def.relationTarget, value) : null
        if (id) props[name] = { relation: [{ id }] }
        else misses.push(`${name}: no encontré "${String(value)}" en su base relacionada`)
        break
      }
    }
  }
  return { props, misses }
}

/** autor del mention → su usuario de Notion, por email (scope users:read.email; null si no se puede) */
async function notionUserFor(chatUserId: string): Promise<string | null> {
  const email = await chat.emailOf?.(chatUserId).catch(() => null)
  if (!email) return null
  try {
    let cursor: string | undefined
    do {
      const res = await notion!.users.list({ page_size: 100, start_cursor: cursor }) as {
        results: Array<{ id: string; type: string; person?: { email?: string } }>; has_more: boolean; next_cursor: string | null
      }
      const hit = res.results.find(u => u.type === 'person' && u.person?.email?.toLowerCase() === email.toLowerCase())
      if (hit) return hit.id
      cursor = res.has_more ? res.next_cursor ?? undefined : undefined
    } while (cursor)
  } catch { /* sin permiso de listar usuarios */ }
  return null
}

/** el card ya trabajó ese repo antes → heredar el doc del proyecto del card hermano más reciente */
async function inheritedDocFrom(repoUrl: string): Promise<Record<string, unknown>> {
  const prop = bridge.config.project_doc_property
  if (!prop) return {}
  try {
    const res = await notion!.dataSources.query({
      data_source_id: process.env.DATA_SOURCE_ID!,
      filter: { property: bridge.config.repo_property, url: { equals: repoUrl } },
      page_size: 5,
    } as never) as { results: Array<{ properties: Record<string, { type?: string; url?: string | null; relation?: Array<{ id: string }> }> }> }
    for (const sibling of res.results) {
      const v = sibling.properties[prop]
      if (v?.type === 'url' && v.url) return { [prop]: { url: v.url } }
      if (v?.type === 'relation' && v.relation?.length) return { [prop]: { relation: v.relation } }
    }
  } catch { /* board sin propiedad Repo tipo url, o sin hermanos */ }
  return {}
}

/** true = vivo · false = borrado/archivado · null = no se pudo saber (error transitorio) */
async function cardAlive(pageId: string): Promise<boolean | null> {
  try {
    const page = await notion!.pages.retrieve({ page_id: pageId }) as { archived?: boolean; in_trash?: boolean }
    return !(page.archived || page.in_trash)
  } catch (err) {
    return /object_not_found|could not find/i.test((err as Error).message) ? false : null
  }
}

type BotMentionMsg = { channelId: string; text: string; userId: string; threadTs?: string; transcript?: string; participants?: string[] }

async function onBotMention(msg: BotMentionMsg): Promise<void> {
  if (!notion || !process.env.DATA_SOURCE_ID) return
  const { channelId, threadTs } = msg

  // el hilo ya tiene card → follow-up sobre ese card, nunca un duplicado
  const tkey = threadKey(channelId, threadTs ?? '')
  const followUpPage = pageOfThread(tkey)
  if (followUpPage) {
    const alive = await cardAlive(followUpPage)
    if (alive !== false) return followUpFromChat(followUpPage, msg)
    // el card mapeado fue BORRADO en Notion → cerrar su sala y caer al flujo de
    // creación: el hilo se re-mapea al card nuevo (saveThread lo sobreescribe)
    jlog('thread_card_gone', { page_id: followUpPage, channel: channelId })
    void chat.archiveRoom(followUpPage, '🗑 el card de Notion fue borrado — cierro esta sala.').catch(() => {})
  }

  // mención pelada sin hilo: guiar, nunca callar
  if (!msg.text && !msg.transcript) {
    return void chat.postTo(channelId, `dime qué necesitas: \`@${bridge.config.name} <descripción de la tarea>\` — si me mencionas dentro de un hilo, leo todo el hilo como contexto (opcional: link del repo y un @rol como \`@pm\`).`, threadTs).catch(() => {})
  }

  // el intake tarda unos segundos → ack inmediato (setStatus nativo en el panel de agente; texto si no)
  void (async () => {
    if (!(await chat.ackWorking?.(channelId, threadTs).catch(() => false))) await chat.postTo(channelId, '👀 leyendo…', threadTs)
  })().catch(() => {})

  const schema = await boardSchema().catch(() => ({} as Record<string, DsProp>))
  const fillable = fillableFrom(schema)
  const intake = await runIntake({ text: msg.text, transcript: msg.transcript, repos: listRepos(), roles: roleAliases(), fillable }, bridge.config.intake)
  // el intake dice "esto no es una tarea" (pregunta/charla, típico en el DM) → conversar, no crear
  if (intake && !intake.title && !intake.description_md && !intake.repo && !intake.role && Object.keys(intake.properties ?? {}).length === 0) {
    jlog('chat_not_a_task', { channel: channelId })
    return void chat.postTo(channelId, intake.reply || 'dime qué necesitas: descríbeme la tarea (o el bug) y yo armo el card.', threadTs).catch(() => {})
  }
  const repoUrl = intake?.repo ?? repoFromText(msg.text)
  const roleTargets = intake?.role && bridge.config.agents[intake.role]
    ? [intake.role]
    : findMentionTargets(msg.text, bridge.config)
  const title = (intake?.title || msg.text.replace(/@\w+/g, '').trim().split('\n')[0].slice(0, 80) || 'Tarea desde Slack').slice(0, 90)

  // propiedades extra: juicio del intake + deterministas — Owner (autor del mention),
  // involucrados del hilo (participants_property) y doc del proyecto (herencia por repo)
  const { props: extraProps, misses: propMisses } = await resolveProps(intake?.properties ?? {}, fillable)
  const partProp = bridge.config.participants_property
  // owner_property si el board la tiene; si no (o si es null), la primera people libre
  const configuredOwner = bridge.config.owner_property
  const ownerProp = (configuredOwner && schema[configuredOwner]?.type === 'people' ? configuredOwner : undefined)
    ?? Object.entries(schema).filter(([n, p]) => p.type === 'people' && n !== partProp).map(([n]) => n)[0]
  if (ownerProp && !extraProps[ownerProp]) {
    const owner = await notionUserFor(msg.userId)
    if (owner) extraProps[ownerProp] = { people: [{ id: owner }] }
  }
  if (partProp && schema[partProp]?.type === 'people' && msg.participants?.length) {
    const mapped = (await Promise.all(msg.participants.map(u => notionUserFor(u)))).filter((id): id is string => Boolean(id))
    if (mapped.length > 0) extraProps[partProp] = { people: mapped.map(id => ({ id })) }
  }
  if (repoUrl) Object.assign(extraProps, await inheritedDocFrom(repoUrl))

  try {
    const page = await notion.pages.create({
      parent: { type: 'data_source_id', data_source_id: process.env.DATA_SOURCE_ID },
      properties: {
        // 'title' es el ID universal de la propiedad título (el nombre visible varía por board)
        title: { title: [{ text: { content: title } }] },
        // explícito: el default del board puede ser cualquier columna (aquí era Planning 🤖)
        [bridge.config.status_property]: { status: { name: bridge.config.states[0].name } },
        ...(repoUrl ? { [bridge.config.repo_property]: { url: repoUrl } } : {}),
        ...extraProps,
      },
    } as never) as { id: string }

    const body = [
      intake?.description_md || `${msg.text}\n\n(creado desde Slack)`,
      ...(msg.transcript ? ['## Hilo de origen (Slack)', msg.transcript.split('\n').map(l => `> ${l}`).join('\n')] : []),
    ].join('\n\n')
    await appendMd(page.id, body)

    saveThread(tkey, page.id)
    // título e invitados ANTES de ensureRoom: el slug y las invitaciones salen de aquí
    saveRoom(page.id, { title, ...(msg.participants?.length ? { pendingInvites: msg.participants } : {}) } as never)
    jlog('card_from_chat', { page_id: page.id, channel: channelId, repo: repoUrl ?? null, role: roleTargets[0] ?? null, thread: Boolean(msg.transcript), intake: Boolean(intake), props: Object.keys(extraProps) })

    // la sala nace CON el card (no al primer agente): ahí sigue la conversación
    const roomId = await chat.ensureRoom(page.id, cardUrl(page.id)).catch(() => null)
    if (roomId) await chat.post(page.id, {}, `📌 card: ${cardUrl(page.id)} — este es el canal de la tarea: escribe aquí para corregir al agente o menciona un @rol para arrancarlo.`).catch(() => {})

    const lines = [intake?.reply || '✅ Card creado.', `· card: ${cardUrl(page.id)}${roomId ? ` · sala: <#${roomId}>` : ''}`]
    if (Object.keys(extraProps).length > 0) lines.push(`· propiedades: ${Object.keys(extraProps).join(', ')}`)
    for (const miss of propMisses) lines.push(`· ⚠️ ${miss}`)
    if (!repoUrl) lines.push('· sin repo — respóndeme aquí con el link de GitHub y lo engancho al card')
    if (roleTargets.length > 0) {
      launch(page.id, roleTargets[0], ['--mode', 'mention', '--hop', '0', '--comment-b64', Buffer.from(msg.text || title).toString('base64')], 'mention')
      lines.push(`· arrancando \`${roleTargets[0]}\``)
    }
    await chat.postTo(channelId, lines.join('\n'), threadTs)
  } catch (err) {
    jlog('card_from_chat_error', { error: (err as Error).message })
    await chat.postTo(channelId, `⚠️ no pude crear el card: ${(err as Error).message}`, threadTs).catch(() => {})
  }
}

/** Follow-up en el hilo de origen (mención al bot sobre un card ya creado). */
function followUpFromChat(pageId: string, msg: BotMentionMsg): Promise<void> {
  jlog('chat_thread_followup', { page_id: pageId, channel: msg.channelId })
  return applyChatUpdate(pageId, { text: msg.text, transcript: msg.transcript }, t => chat.postTo(msg.channelId, t, msg.threadTs), 'thread')
}

/**
 * Aplica un mensaje de chat al CARD: repo/rol directos por regex; lo demás lo
 * interpreta el intake (propiedades, notas, respuesta). `respond` decide dónde
 * contestar (hilo de origen o sala). Modo:
 *   'thread' — mención explícita al bot: sin intake, el texto al menos queda como nota.
 *   'room'   — mensaje suelto en la sala sin agente vivo: solo se aplica lo que el
 *              intake afirme (nada de volcar charla ajena al card).
 */
async function applyChatUpdate(pageId: string, input: { text: string; transcript?: string }, respond: (t: string) => Promise<void>, mode: 'thread' | 'room'): Promise<void> {
  let repoUrl = repoFromText(input.text)
  let roleTargets = findMentionTargets(input.text, bridge.config)
  let note: string | undefined
  let replyText: string | undefined

  let extraProps: Record<string, unknown> = {}
  let propMisses: string[] = []
  if (!repoUrl && roleTargets.length === 0) {
    void respond('👀 leyendo…').catch(() => {})
    const card = await cardSummary(pageId).catch(() => null)
    const schema = await boardSchema().catch(() => ({} as Record<string, DsProp>))
    const fillable = fillableFrom(schema)
    const intake = await runIntake({ text: input.text, transcript: input.transcript, repos: listRepos(), roles: roleAliases(), fillable, existingCard: card ?? undefined }, bridge.config.intake)
    if (intake) {
      repoUrl = intake.repo ?? undefined
      if (intake.role && bridge.config.agents[intake.role]) roleTargets = [intake.role]
      note = intake.description_md || undefined
      replyText = intake.reply || undefined
      ;({ props: extraProps, misses: propMisses } = await resolveProps(intake.properties ?? {}, fillable))
    } else if (mode === 'thread' && input.text) {
      note = input.text // sin intake: que al menos quede registrado en el card
    } else if (mode === 'room') {
      // sin intake no hay forma de interpretar el mensaje: comportamiento clásico
      return void respond('no hay agente vivo en este card — menciona un @rol (p. ej. `@qa revisa el PR`) para lanzar uno.').catch(() => {})
    }
  }

  try {
    const done: string[] = []
    if (repoUrl) {
      // el repo llegó tarde → es el momento de heredar el doc del proyecto de sus hermanos
      Object.assign(extraProps, await inheritedDocFrom(repoUrl))
      extraProps[bridge.config.repo_property] = { url: repoUrl }
      done.push(`repo enganchado: ${repoUrl}`)
    }
    if (Object.keys(extraProps).length > 0) {
      await notion!.pages.update({ page_id: pageId, properties: extraProps } as never)
      const others = Object.keys(extraProps).filter(k => k !== bridge.config.repo_property)
      if (others.length > 0) done.push(`propiedades: ${others.join(', ')}`)
    }
    if (note) {
      await appendMd(pageId, `**Actualización desde Slack:** ${note}`)
      done.push('nota añadida al card')
    }
    if (roleTargets.length > 0) {
      const args = ['--mode', 'mention', '--hop', '0', '--comment-b64', Buffer.from(input.text || 'follow-up desde Slack').toString('base64')]
      if (inFlightPages.has(pageId)) enqueueTrigger(pageId, { agent: roleTargets[0], extraArgs: args, lockReason: 'mention' })
      else launch(pageId, roleTargets[0], args, 'mention')
      done.push(`arrancando \`${roleTargets[0]}\``)
    }
    const reply = [replyText, done.length ? `✅ ${done.join(' · ')}` : undefined, ...propMisses.map(m => `· ⚠️ ${m}`), `· card: ${cardUrl(pageId)}`].filter(Boolean).join('\n')
    await respond(reply)
  } catch (err) {
    jlog('chat_update_error', { page_id: pageId, mode, error: (err as Error).message })
    if (/object_not_found|could not find/i.test((err as Error).message)) {
      await respond(`🗑 este card ya no existe en Notion — cierro la sala; menciona a @${bridge.config.name} en un canal para crear uno nuevo.`).catch(() => {})
      void chat.archiveRoom(pageId, '🗑 card borrado en Notion — sala cerrada.').catch(() => {})
      return
    }
    await respond(`⚠️ no pude aplicar la actualización: ${(err as Error).message}`).catch(() => {})
  }
}

/** Mensajes humanos en la sala de Slack: @rol → lanzar · "stop" → interrumpir · texto → intervenir. */
function onChatMessage(msg: { pageId: string; text: string; userId: string }): void {
  const { pageId, text } = msg
  const room = roomOf(pageId)
  jlog('chat_message', { page_id: pageId, user: msg.userId, len: text.length })

  const targets = findMentionTargets(text, bridge.config)
  if (targets.length > 0) {
    const target = targets[0]
    const args = ['--mode', 'mention', '--hop', '0', '--comment-b64', Buffer.from(text).toString('base64')]
    if (inFlightPages.has(pageId)) {
      return enqueueTrigger(pageId, { agent: target, extraArgs: args, lockReason: 'mention' })
    }
    jlog('mention_human', { page_id: pageId, target, source: 'chat' })
    return launch(pageId, target, args, 'mention')
  }

  if (/^\s*(stop|para|detente)\s*$/i.test(text)) {
    const ok = room?.label ? interruptLiveAgent(room.label) : false
    void chat.post(pageId, {}, ok ? '🛑 agente interrumpido — escribe la corrección o menciona un @rol.' : 'no hay agente vivo que interrumpir.')
    return void jlog('chat_interrupt', { page_id: pageId, ok })
  }

  // texto plano: corrección a media tarea → inyectar al pane vivo;
  // sin agente vivo, el mensaje es para el CARD → intake (propiedades, repo, notas)
  const ok = room?.label ? sendToLiveAgent(room.label, text) : false
  if (ok) {
    jlog('chat_intervention', { page_id: pageId })
  } else {
    jlog('chat_room_intake', { page_id: pageId })
    void applyChatUpdate(pageId, { text }, t => chat.post(pageId, {}, t), 'room')
      .catch(err => jlog('chat_room_intake_error', { page_id: pageId, error: (err as Error).message }))
  }
}

server.listen(PORT, HOST, async () => {
  console.log(`${bridge.config.name} (regent) escuchando en http://${HOST}:${PORT}${WEBHOOK_PATH}`)
  console.log(`  REPO_PATH=${process.env.REPO_PATH} (carpeta de repos; el card elige con su propiedad Repo)`)
  const triggers = bridge.triggerStates.map(s => `"${s.name}"→${s.trigger}`).join(', ')
  console.log(`  DATABASE_ID=${DATABASE_ID ?? '(no configurado)'}  triggers: ${triggers}`)
  console.log(`  verification token: ${verificationToken ? 'configurado ✓' : 'PENDIENTE (llegará en el handshake)'}`)
  warnMovedEnv()
  chat = await createChatAdapter({
    ...bridge.config.chat,
    name: bridge.config.name,
    role_mentions: Object.fromEntries(Object.entries(bridge.config.agents).map(([r, a]) => [r, (a.triggers?.mentions ?? [])[0] ?? `@${r}`])),
  })
  try {
    await chat.start({ onMessage: onChatMessage, onBotMention: msg => void onBotMention(msg) })
    console.log(`  chat: ${chat.name}${chat.name === 'noop' ? ' (sin SLACK_BOT_TOKEN/SLACK_APP_TOKEN)' : ' ✓'}`)
  } catch (err) {
    console.warn(`⚠️  adapter de chat falló (${(err as Error).message}); sigo sin chat`)
    chat = (await import('./chat.ts')).noopAdapter
  }
  if (bridge.config.pr_merged_moves_to) {
    // el mismo ciclo re-evalúa los forwarders: un repo nuevo en el board entra solo
    setInterval(() => void pollMergedPRs().then(refreshGithubForwarders), PR_POLL_MIN * 60 * 1000).unref()
    console.log(`  pr: /github-webhook (evento) + poll de respaldo cada ${PR_POLL_MIN} min → "${bridge.config.pr_merged_moves_to}" ✓`)
    await refreshGithubForwarders()
  } else {
    console.log('  pr: off (define pr_merged_moves_to en workflow.json)')
  }
  await fetchBotUserId()
  await checkBoardDrift()
  setInterval(() => void checkBoardDrift(), 60 * 60 * 1000).unref()
})
