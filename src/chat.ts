/**
 * Contrato del adaptador de chat — la SALA efímera por card (Notion = registro).
 * Las personas/roles no saben qué chat hay detrás; soportar otro chat = otro adapter.
 *
 * Sin tokens configurados → adapter noop (el pipeline funciona igual que siempre).
 * El mapa card→sala se persiste en log/rooms.json.
 */
import fs from 'node:fs'
import path from 'node:path'
import { BRIDGE_DIR } from './env.ts'

export interface ChatPersona {
  username?: string
  emoji?: string
  /** rol del pipeline: si el adapter tiene una cara real para él (app de identidad), postea con ella */
  role?: string
}

export interface InboundMessage {
  pageId: string
  text: string
  userId: string
}

export interface ChatHandlers {
  onMessage: (msg: InboundMessage) => void
  /** mención al bot FUERA de una sala (p. ej. "@regent crea una tarea: …");
   *  si vino en un hilo, transcript+participants traen el contexto completo */
  onBotMention?: (msg: { channelId: string; text: string; userId: string; threadTs?: string; transcript?: string; participants?: string[]; unreadable?: string }) => void
}

export interface ChatAdapter {
  readonly name: string
  /** conecta (Socket Mode etc.) y registra el handler de mensajes entrantes */
  start(handlers: ChatHandlers): Promise<void>
  /** crea (o reutiliza) la sala del card; null si el adapter no puede */
  ensureRoom(pageId: string, topic?: string): Promise<string | null>
  /** publica en la sala del card firmando como la persona del rol */
  post(pageId: string, persona: ChatPersona, text: string): Promise<void>
  /** responde en un canal/hilo arbitrario (fuera de salas; p. ej. al crear un card) */
  postTo(channelId: string, text: string, threadTs?: string): Promise<void>
  /** archiva la sala dejando un mensaje final */
  archiveRoom(pageId: string, summary: string): Promise<void>
  /** email del usuario del chat (para mapearlo a su usuario de Notion); null si el adapter no puede */
  emailOf?(userId: string): Promise<string | null>
  /** feedback "estoy trabajando" nativo (p. ej. assistant.threads.setStatus); false = el caller postea texto */
  ackWorking?(channelId: string, threadTs?: string): Promise<boolean>
  /** conversación HUMANA de la sala del card (cronológica, líneas "@quien: texto"); null si no hay */
  historyOf?(pageId: string): Promise<string[] | null>
}

// ---------- mapa card → sala (+ último agente lanzado, para intervención) ----------

export interface RoomInfo {
  channelId: string
  /** label del último launch (agent-shortid): prefijo del agente vivo en herdr/tmux */
  label?: string
  agent?: string
  /** tabs de herdr / sesiones tmux abiertos por este card — se cierran al llegar a terminal */
  tabRefs?: string[]
  /** título del card (para nombrar la sala legiblemente) */
  title?: string
  /** user ids a invitar al crear la sala (p. ej. participantes del hilo de origen) */
  pendingInvites?: string[]
}

const ROOMS_FILE = path.join(BRIDGE_DIR, 'log', 'rooms.json')

export function loadRooms(): Record<string, RoomInfo> {
  try { return JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8')) } catch { return {} }
}

export function saveRoom(pageId: string, patch: Partial<RoomInfo>): void {
  const rooms = loadRooms()
  rooms[pageId] = { ...rooms[pageId], ...patch } as RoomInfo
  fs.mkdirSync(path.dirname(ROOMS_FILE), { recursive: true })
  fs.writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2))
}

export function roomOf(pageId: string): RoomInfo | undefined {
  return loadRooms()[pageId]
}

// ---------- mapa hilo de chat → card ----------
// Un follow-up en el mismo hilo (p. ej. "el repo es este …") debe ir al card ya
// creado, nunca crear un duplicado ni perderse.

const THREADS_FILE = path.join(BRIDGE_DIR, 'log', 'threads.json')

export const threadKey = (channelId: string, threadTs: string): string => `${channelId}:${threadTs}`

export function pageOfThread(key: string): string | undefined {
  try { return (JSON.parse(fs.readFileSync(THREADS_FILE, 'utf8')) as Record<string, string>)[key] } catch { return undefined }
}

export function saveThread(key: string, pageId: string): void {
  let map: Record<string, string> = {}
  try { map = JSON.parse(fs.readFileSync(THREADS_FILE, 'utf8')) } catch { /* primer uso */ }
  map[key] = pageId
  fs.mkdirSync(path.dirname(THREADS_FILE), { recursive: true })
  fs.writeFileSync(THREADS_FILE, JSON.stringify(map, null, 2))
}

// ---------- noop (default sin configuración) ----------

export const noopAdapter: ChatAdapter = {
  name: 'noop',
  async start() { /* nada */ },
  async ensureRoom() { return null },
  async post() { /* nada */ },
  async postTo() { /* nada */ },
  async archiveRoom() { /* nada */ },
}

/** config de sala (workflow.json → `chat`); los TOKENS siguen en .env por ser secretos */
export interface ChatConfig {
  /** nombre de la instancia (workflow.json → `name`): identidad del hub al firmar mensajes */
  name: string
  invite_users: string[]
  auto_invite_limit: number
  /** rol → alias de mención del router (p. ej. pm → "@pm"): traduce menciones REALES <@U_rol> */
  role_mentions: Record<string, string>
}

/** slack si hay tokens en el entorno; si no, noop. */
export async function createChatAdapter(cfg: ChatConfig): Promise<ChatAdapter> {
  if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    const { createSlackAdapter } = await import('./chat-slack.ts')
    return createSlackAdapter(cfg)
  }
  return noopAdapter
}
