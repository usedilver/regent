/**
 * Backends de terminal para correr el agente:
 *   herdr    — tab + claude interactivo gestionado (estados/notificaciones/intervención)
 *   tmux     — sesión detached con claude interactivo (attach por SSH para intervenir)
 *   headless — claude -p en background con log (sin intervención)
 *
 * Contrato v1: launchAgent() — cada backend hace su baile completo. El contrato fino
 * (abrirPane/leer/enviarTexto) se formaliza con el adaptador de chat (Fase 3).
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'

export interface LaunchInput {
  cwd: string
  label: string
  /** argv de claude SIN el prompt (flags de system prompt, tools, model) */
  claudeArgs: string[]
  /** prompt de fase (se envía como input interactivo o como arg de -p) */
  promptText: string
  logFile: string
  /** variables para el proceso de claude (además del entorno del backend) */
  env?: Record<string, string>
}

/** `--env K=V --env K2=V2`: un flag repetido por variable, como piden herdr y tmux. */
export function envFlags(flag: string, env: Record<string, string> | undefined): string[] {
  return Object.entries(env ?? {}).flatMap(([k, v]) => [flag, `${k}=${v}`])
}

export interface LaunchResult {
  backend: 'herdr' | 'tmux' | 'headless'
  ref: string
  /** id del tab de herdr (o sesión tmux) — para cerrarlo cuando el card llegue a terminal */
  tabRef?: string
}

/** Cierra un tab de herdr (`w5:t7`) o una sesión tmux (por nombre). Best-effort. */
export function closeTab(tabRef: string): boolean {
  try {
    if (/^w\d+:t/.test(tabRef)) { sh('herdr', ['tab', 'close', tabRef]); return true }
    sh('tmux', ['kill-session', '-t', tabRef])
    return true
  } catch { return false }
}

/** tab_id → agent_status de los tabs vivos de herdr. */
function herdrTabStatuses(): Map<string, string> {
  const list = JSON.parse(sh('herdr', ['tab', 'list']))
  const tabs: { tab_id?: string; agent_status?: string }[] = list.result?.tabs ?? []
  return new Map(tabs.filter(t => t.tab_id).map(t => [t.tab_id!, t.agent_status ?? 'idle']))
}

/**
 * Cierra los tabs de fases ya terminadas de un card. Un tab de herdr con agente
 * aún `working` se respeta (la fase previa podría estar cerrando su protocolo).
 * Devuelve los refs que dejaron de existir (cerrados aquí o ya inexistentes).
 */
export function closeFinishedTabs(tabRefs: string[]): string[] {
  const gone: string[] = []
  let statuses: Map<string, string> | null | undefined // undefined = sin consultar; null = herdr caído
  for (const ref of tabRefs) {
    if (/^w\d+:t/.test(ref)) {
      if (statuses === undefined) { try { statuses = herdrTabStatuses() } catch { statuses = null } }
      if (statuses === null) continue
      const status = statuses.get(ref)
      if (status === undefined) { gone.push(ref); continue } // el tab ya no existe
      if (status !== 'idle') continue
    }
    if (closeTab(ref)) gone.push(ref)
  }
  return gone
}

const sh = (cmd: string, args: string[], opts: object = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }) as string

export function detectBackend(): LaunchResult['backend'] {
  const forced = process.env.TERMINAL_BACKEND as LaunchResult['backend'] | undefined
  if (forced) return forced
  // herdr habla por socket: funciona aunque el server NO corra dentro de un pane
  try { sh('herdr', ['tab', 'list']); return 'herdr' } catch { /* sin server de herdr */ }
  try { sh('tmux', ['-V']); return 'tmux' } catch { /* no tmux */ }
  return 'headless'
}

// ---------- herdr ----------

function launchHerdr(i: LaunchInput): LaunchResult {
  const tab = JSON.parse(sh('herdr', ['tab', 'create', '--cwd', i.cwd, '--label', i.label, '--no-focus', ...envFlags('--env', i.env)]))
  const paneId: string = tab.result?.root_pane?.pane_id ?? tab.result?.root_pane?.id
  const tabId: string | undefined = tab.result?.tab?.tab_id
  if (!paneId) throw new Error('herdr tab create no devolvió pane_id')

  const agentName = `${i.label}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 31)
  // el shell del tab tarda un instante (agent_pane_busy) → reintentos
  let started = false
  for (let n = 0; n < 5 && !started; n++) {
    try {
      sh('herdr', ['agent', 'start', agentName, '--kind', 'claude', '--pane', paneId, '--', ...i.claudeArgs])
      started = true
    } catch { execFileSync('sleep', ['2']) }
  }
  if (!started) throw new Error(`herdr agent start falló 5 veces en pane ${paneId}`)
  sh('herdr', ['agent', 'prompt', agentName, i.promptText])
  return { backend: 'herdr', ref: `${agentName} @ ${paneId}`, tabRef: tabId }
}

// ---------- tmux ----------

function launchTmux(i: LaunchInput): LaunchResult {
  const session = i.label.replace(/[^a-zA-Z0-9_-]/g, '-')
  sh('tmux', ['new-session', '-d', '-s', session, '-c', i.cwd, ...envFlags('-e', i.env)]) // -e: tmux ≥ 3.2
  // claude interactivo en la sesión (permite attach + intervenir); el prompt via buffer
  // para no pelear con quoting de send-keys
  const cmd = ['claude', ...i.claudeArgs].map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')
  sh('tmux', ['send-keys', '-t', session, cmd, 'Enter'])
  execFileSync('sleep', ['4']) // claude interactivo arrancando
  const tmpBuf = `${i.logFile}.prompt`
  fs.writeFileSync(tmpBuf, i.promptText)
  sh('tmux', ['load-buffer', '-b', session, tmpBuf])
  sh('tmux', ['paste-buffer', '-b', session, '-t', session, '-d'])
  sh('tmux', ['send-keys', '-t', session, 'Enter'])
  fs.rmSync(tmpBuf, { force: true })
  return { backend: 'tmux', ref: session, tabRef: session }
}

// ---------- headless ----------

function launchHeadless(i: LaunchInput): LaunchResult {
  const out = fs.openSync(i.logFile, 'a')
  const child = spawn('claude', ['-p', i.promptText, ...i.claudeArgs], {
    cwd: i.cwd, detached: true, stdio: ['ignore', out, out], env: { ...process.env, ...i.env },
  })
  child.unref()
  return { backend: 'headless', ref: `pid ${child.pid} → ${i.logFile}` }
}

// ---------- intervención sobre agentes vivos (desde el chat) ----------

interface HerdrAgent { name?: string; agent_status?: string; pane_id?: string }

function findHerdrAgent(labelPrefix: string): HerdrAgent | undefined {
  try {
    const list = JSON.parse(sh('herdr', ['agent', 'list']))
    const agents: HerdrAgent[] = list.result?.agents ?? []
    return agents.find(a => a.name?.startsWith(labelPrefix.toLowerCase()))
  } catch { return undefined }
}

/** Inyecta texto al agente vivo del card (corrección a media tarea). true si lo encontró. */
export function sendToLiveAgent(labelPrefix: string, text: string): boolean {
  const a = findHerdrAgent(labelPrefix)
  if (a?.name) {
    try { sh('herdr', ['agent', 'prompt', a.name, text]); return true } catch { /* sigue */ }
  }
  try { // tmux: la sesión se llama exactamente como el label
    sh('tmux', ['has-session', '-t', labelPrefix])
    const buf = `/tmp/bridge-intervene-${Date.now()}`
    fs.writeFileSync(buf, text)
    sh('tmux', ['load-buffer', '-b', labelPrefix, buf])
    sh('tmux', ['paste-buffer', '-b', labelPrefix, '-t', labelPrefix, '-d'])
    sh('tmux', ['send-keys', '-t', labelPrefix, 'Enter'])
    fs.rmSync(buf, { force: true })
    return true
  } catch { return false }
}

/** Interrumpe al agente vivo (equivalente a Esc). true si lo encontró. */
export function interruptLiveAgent(labelPrefix: string): boolean {
  const a = findHerdrAgent(labelPrefix)
  if (a?.name) {
    try { sh('herdr', ['agent', 'send-keys', a.name, 'esc']); return true } catch { /* sigue */ }
  }
  try {
    sh('tmux', ['has-session', '-t', labelPrefix])
    sh('tmux', ['send-keys', '-t', labelPrefix, 'Escape'])
    return true
  } catch { return false }
}

export function launchAgent(i: LaunchInput): LaunchResult {
  const backend = detectBackend()
  try {
    if (backend === 'herdr') return launchHerdr(i)
    if (backend === 'tmux') return launchTmux(i)
  } catch (err) {
    console.error(`[terminal] backend ${backend} falló (${(err as Error).message}); fallback headless`)
  }
  return launchHeadless(i)
}
