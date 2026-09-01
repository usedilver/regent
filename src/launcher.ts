#!/usr/bin/env node
/**
 * launcher — lanza el agente de una fase para un card.
 * Uso: node src/launcher.ts <page_id> <agent_name>
 *
 * El harness es Claude Code: lanzamos `claude` con cwd en el repo del cliente
 * (o su worktree) y el CLI carga solo CLAUDE.md, .claude/skills, .mcp.json y
 * permisos. El cuerpo del agent nativo va como system prompt; el protocolo del
 * pipeline + el card van como prompt de fase.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { BRIDGE_DIR, loadEnv } from './env.ts'
import { loadBridge, parseAgentFile, type LoadedBridge, type BridgeConfig } from './bridge-config.ts'
import { buildPhasePrompt } from './phase-prompt.ts'
import { launchAgent, closeFinishedTabs } from './terminal.ts'
import { roomOf, saveRoom } from './chat.ts'

loadEnv()

const NCARD = path.join(BRIDGE_DIR, 'ncard')
const LOG_DIR = path.join(BRIDGE_DIR, 'log')
const TMP_DIR = path.join(BRIDGE_DIR, 'tmp')

const sh = (cmd: string, args: string[], opts: object = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', ...opts }) as string

interface Card {
  page_id: string
  title: string
  status: string | null
  properties: Record<string, unknown>
  [k: string]: unknown
}

/**
 * Pre-siembra en ~/.claude.json las dos aprobaciones que claude pide al entrar
 * por primera vez a un directorio, y que dejarían al agente esperando input:
 *
 *   1. "trust this folder" → projects[dir].hasTrustDialogAccepted
 *   2. "New MCP server found in this project" → enabledMcpjsonServers, por cada
 *      servidor del .mcp.json del repo
 *
 * Sin esto el agente arranca BLOQUEADO en un prompt y el texto de la fase lo
 * contesta por accidente. REPO_PATH y el .mcp.json del repo son configuración
 * deliberada del operador; lo que el operador desactivó a mano se respeta.
 */
/** Busca un archivo desde `from` hacia arriba, sin salir de $HOME. */
function findUp(name: string, from: string): string | null {
  const home = process.env.HOME ?? '/'
  let cur = path.resolve(from)
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(cur, name)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(cur)
    if (parent === cur || cur === home) return null
    cur = parent
  }
  return null
}

function ensureTrusted(dir: string): void {
  const cfgPath = path.join(process.env.HOME ?? '', '.claude.json')
  if (!fs.existsSync(cfgPath)) return // primer arranque global de claude: no interferir
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    cfg.projects ??= {}
    const proj = (cfg.projects[dir] ??= {})
    let changed = false

    if (proj.hasTrustDialogAccepted !== true) {
      proj.hasTrustDialogAccepted = true
      changed = true
      console.log(`[launcher] trust pre-sembrado para ${dir}`)
    }

    // claude busca .mcp.json hacia ARRIBA: el agente corre en un submódulo
    // (…/talently-code/frontend/frontend-hire) y el archivo vive en la raíz del
    // monorepo. Mirar solo el cwd dejaba el diálogo sin pre-aprobar.
    const mcpPath = findUp('.mcp.json', dir)
    if (mcpPath) {
      const declared = Object.keys(JSON.parse(fs.readFileSync(mcpPath, 'utf8')).mcpServers ?? {})
      proj.enabledMcpjsonServers ??= []
      proj.disabledMcpjsonServers ??= []
      const nuevos = declared.filter(n =>
        !proj.enabledMcpjsonServers.includes(n) && !proj.disabledMcpjsonServers.includes(n))
      if (nuevos.length) {
        proj.enabledMcpjsonServers.push(...nuevos)
        changed = true
        console.log(`[launcher] MCP del repo aprobados: ${nuevos.join(', ')}`)
      }
    }

    if (changed) fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
  } catch (err) {
    console.warn(`[launcher] no pude sembrar trust/MCP (${(err as Error).message}); claude puede pedir confirmación`)
  }
}

/**
 * Resuelve el repo de trabajo del CARD dentro de REPO_PATH (la carpeta de repos).
 *   1. propiedad Repo (url de GitHub) → buscar clon existente hasta tres niveles adentro
 *      de REPO_PATH: por nombre de carpeta y, si no, por origin — el path de un submódulo
 *      no siempre se llama como su repo (backend/l9-backend → l9-ops-backend-api)
 *   2. si no está clonado → EL AGENTE LO CLONA (gh, fallback git) a REPO_PATH/<name>
 *   3. sin Repo → no se ejecuta: se solicita por comentario
 */
function originMatches(dir: string, owner: string, name: string): boolean {
  try {
    const origin = sh('git', ['-C', dir, 'remote', 'get-url', 'origin'], { stdio: ['ignore', 'pipe', 'ignore'] }).trim().toLowerCase()
    return origin.includes(`${owner.toLowerCase()}/${name.toLowerCase()}`)
  } catch { return false }
}

function resolveCardRepo(card: Card): string {
  const reposRoot = (process.env.REPO_PATH ?? '').replace(/^~/, process.env.HOME ?? '')
  if (!reposRoot || !fs.existsSync(reposRoot)) throw new Error(`REPO_PATH no existe: "${reposRoot}"`)

  const repoUrl = (card as { repo?: string }).repo ?? ''
  const m = repoUrl.match(/github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/)
  if (!m) {
    // sin repo no se ejecuta nada: se solicita por comentario
    throw new Error('el card no tiene la propiedad Repo — pon el link de GitHub del repo y vuelve a activar (drag o mención)')
  }
  const [, owner, name] = m

  // Clones existentes hasta tres niveles adentro — cubre carpetas-organización
  // (<root>/<org>/<name>) y submódulos de un monorepo (<root>/<mono>/backend/<name>).
  const repoDirs: string[] = []
  const scan = (dir: string, depth: number): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
      const full = path.join(dir, e.name)
      if (fs.existsSync(path.join(full, '.git'))) repoDirs.push(full)
      if (depth < 3) scan(full, depth + 1)
    }
  }
  scan(reposRoot, 1)

  // 1) por nombre de carpeta; 2) por origin — el path de un submódulo puede no
  // llamarse como su repo. El origin valida en ambos casos.
  const dir = repoDirs.find(d => path.basename(d) === name && originMatches(d, owner, name))
    ?? repoDirs.find(d => path.basename(d) !== name && originMatches(d, owner, name))
  if (dir) {
    try { sh('git', ['-C', dir, 'fetch', 'origin', '--quiet']) } catch { /* offline ok */ }
    return dir
  }

  // no está → clonar (lo automático se encarga)
  const dest = path.join(reposRoot, name)
  console.log(`[launcher] clonando ${owner}/${name} → ${dest}`)
  try {
    sh('gh', ['repo', 'clone', `${owner}/${name}`, dest], { stdio: ['ignore', 'inherit', 'inherit'] })
  } catch {
    sh('git', ['clone', repoUrl, dest], { stdio: ['ignore', 'inherit', 'inherit'] })
  }
  if (!fs.existsSync(path.join(dest, '.git'))) throw new Error(`no pude clonar ${owner}/${name} — ¿tiene acceso gh/git a ese repo?`)
  return dest
}

/** El agent efectivo: override del repo (.claude/agents/<n>.md) o el default del bridge. */
function resolveAgent(b: LoadedBridge, agentName: string, repoDir: string) {
  const override = path.join(repoDir, '.claude', 'agents', `${agentName}.md`)
  if (fs.existsSync(override)) {
    console.log(`[launcher] agent "${agentName}" sobrescrito por el repo`)
    return parseAgentFile(override)
  }
  const def = b.agents.get(agentName)
  if (!def) throw new Error(`agent "${agentName}" no existe en ${b.configDir}/agents/`)
  return def
}

/**
 * Rama base del trabajo, en orden y sin heurística:
 *   1. `repo_base_branches[<repo>]` — override explícito del equipo
 *   2. `default_base_branch` (por defecto `develop`) SI existe en el remoto
 *   3. `origin/HEAD` — el default del repo, para los chicos que solo tienen main
 *   4. la rama actual (repo sin remoto)
 * El PR se abre contra esta misma rama: el agente recibe la base en su prompt.
 */
function resolveBaseBranch(repoPath: string, cfg: BridgeConfig): string {
  const exists = (ref: string): boolean => {
    try { sh('git', ['-C', repoPath, 'rev-parse', '--verify', '--quiet', `origin/${ref}`]); return true } catch { return false }
  }
  const override = cfg.repo_base_branches?.[path.basename(repoPath)]
  if (override) return override
  const preferred = cfg.default_base_branch
  if (preferred && exists(preferred)) return preferred
  try {
    const head = sh('git', ['-C', repoPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim().replace(/^origin\//, '')
    if (head) return head
  } catch { /* sin origin/HEAD */ }
  return sh('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD']).trim()
}

function ensureWorktree(repoPath: string, shortId: string, cfg: BridgeConfig): { dir: string; branch: string; baseBranch: string } {
  try { sh('git', ['-C', repoPath, 'fetch', 'origin', '--quiet']) } catch { /* offline ok */ }
  const base = resolveBaseBranch(repoPath, cfg)

  const branch = `agent/${shortId}`
  const dir = path.join(BRIDGE_DIR, 'worktrees', `${path.basename(repoPath)}-${shortId}`)
  fs.mkdirSync(path.join(BRIDGE_DIR, 'worktrees'), { recursive: true })

  if (!fs.existsSync(dir)) {
    const hasBranch = (() => {
      try { sh('git', ['-C', repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]); return true } catch { return false }
    })()
    if (hasBranch) {
      sh('git', ['-C', repoPath, 'worktree', 'add', dir, branch])
    } else {
      let baseRef = `origin/${base}`
      try { sh('git', ['-C', repoPath, 'rev-parse', '--verify', '--quiet', baseRef]) } catch { baseRef = base }
      sh('git', ['-C', repoPath, 'worktree', 'add', '-b', branch, dir, baseRef])
    }
  }
  return { dir, branch, baseBranch: base }
}

export interface RunPhaseOptions {
  mode?: 'column' | 'mention' | 'created'
  hop?: number
  triggerComment?: string
  creatorId?: string
}

export function runPhase(pageId: string, agentName: string, opts: RunPhaseOptions = {}, bridge?: LoadedBridge): void {
  const b = bridge ?? loadBridge()
  const mode = opts.mode ?? 'column'
  // El estado se resuelve por TRIGGER, no por la columna actual del card: así una
  // mención al dev crea igual su worktree aunque el card esté en otra columna.
  const state = b.config.states.find(s => s.trigger === agentName)
  if (mode === 'column' && !state?.agent_moves_to && !state?.agent_stays) {
    throw new Error(`ningún estado tiene trigger "${agentName}" con agent_moves_to o agent_stays`)
  }

  fs.mkdirSync(LOG_DIR, { recursive: true })
  fs.mkdirSync(TMP_DIR, { recursive: true })
  const shortId = pageId.replace(/-/g, '').slice(-12)
  const label = `${agentName}-${shortId}`

  // 1. leer el card (ncard = única implementación del cliente Notion)
  console.log(`[launcher] card ${pageId} agent=${agentName} mode=${mode} hop=${opts.hop ?? 0} → ncard get`)
  const cardJson = sh(NCARD, ['get', pageId])
  const card = JSON.parse(cardJson) as Card

  // 2. cwd: repo del card dentro de REPO_PATH (propiedad Repo), o su worktree.
  // Aplica también en mención: si mencionan al dev para iterar el PR,
  // debe trabajar en el MISMO worktree/rama del card.
  const cardRepo = resolveCardRepo(card)
  console.log(`[launcher] repo del card: ${cardRepo}`)
  const agent = resolveAgent(b, agentName, cardRepo)
  let cwd = cardRepo
  let worktree: { branch: string; baseBranch: string } | undefined
  if (state?.use_worktree) {
    const wt = ensureWorktree(cardRepo, shortId, b.config)
    cwd = wt.dir
    worktree = { branch: wt.branch, baseBranch: wt.baseBranch }
    console.log(`[launcher] worktree=${wt.dir} branch=${wt.branch} base=${wt.baseBranch}`)
  }

  // 3. system prompt = cuerpo del agent nativo (sin frontmatter)
  const sysFile = path.join(TMP_DIR, `sys-${label}.md`)
  fs.writeFileSync(sysFile, agent.body)

  // 3.5 doc de proyecto: propiedad configurable (url de página de Notion o relation);
  // su contenido viaja al prompt como contexto mantenido por el equipo
  let projectDoc: string | undefined
  const docProp = b.config.project_doc_property
  if (docProp) {
    const raw = card.properties?.[docProp]
    const docId = Array.isArray(raw) ? (raw[0] as string | undefined)
      : typeof raw === 'string' ? (raw.match(/([0-9a-f]{32})|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[0])
      : undefined
    if (docId) {
      try {
        const doc = JSON.parse(sh(NCARD, ['get', docId])) as { title?: string; content?: string }
        projectDoc = `# ${doc.title ?? 'Proyecto'}\n\n${(doc.content ?? '').slice(0, 8000)}`
        console.log(`[launcher] doc de proyecto cargado: "${doc.title}" (${projectDoc.length} chars)`)
      } catch { console.warn(`[launcher] no pude leer el doc de proyecto (${docProp}) — sigo sin él`) }
    }
  }

  // 4. prompt de fase = protocolo del bridge + card
  const bridgeAgentCfg = b.config.agents[agentName]
  const canTrigger = (bridgeAgentCfg?.can_trigger ?? [])
    .map(t => ({ agent: t, mention: b.config.agents[t]?.triggers?.mentions?.[0] ?? `@${t}` }))
  const processPath = path.join(BRIDGE_DIR, 'config', 'process.md')
  const processNotes = fs.existsSync(processPath) ? fs.readFileSync(processPath, 'utf8') : undefined
  const promptText = buildPhasePrompt({
    cardJson, pageId, ncardPath: NCARD, mode, state, nextState: state?.agent_moves_to, worktree,
    triggerComment: opts.triggerComment, hop: opts.hop ?? 0, maxHops: b.config.max_hops,
    canTrigger, creatorId: opts.creatorId, projectDoc, processNotes,
  })

  // 5. flags: tools de .bridge (+ ncard siempre); modelo: card > frontmatter > default del CLI
  const allowedTools = [...(bridgeAgentCfg?.allowed_tools ?? []), `Bash(${NCARD}:*)`].join(',')
  const modelProp = b.config.model_property
  const model = (modelProp ? card.properties?.[modelProp] as string | undefined : undefined) || agent.model
  const claudeArgs = ['--allowed-tools', allowedTools, '--append-system-prompt-file', sysFile]
  if (model) claudeArgs.push('--model', model)

  // 6. estado en el board (Agente/Hop = fuente de verdad para handoffs) + lanzar
  ensureTrusted(cwd)
  try {
    sh(NCARD, ['icon', pageId, '🤖'])
    if (b.config.agent_property) sh(NCARD, ['setselect', pageId, b.config.agent_property, agentName])
    if (b.config.hop_property) sh(NCARD, ['setnum', pageId, b.config.hop_property, String(opts.hop ?? 0)])
  } catch { /* propiedades opcionales: no bloquea */ }
  const res = launchAgent({
    cwd, label, claudeArgs, promptText,
    logFile: path.join(LOG_DIR, `agent-${label}.out`),
  })
  // los tabs de fases anteriores del card ya cumplieron: cerrarlos (el nuevo toma el relevo)
  const prev = (roomOf(pageId)?.tabRefs ?? []).filter(t => t !== res.tabRef)
  const gone = closeFinishedTabs(prev)
  if (gone.length) console.log(`[launcher] tabs de fases anteriores cerrados: ${gone.join(', ')}`)
  const tabRefs = [...prev.filter(t => !gone.includes(t)), ...(res.tabRef ? [res.tabRef] : [])]
  if (tabRefs.length || prev.length) saveRoom(pageId, { tabRefs })
  console.log(`[launcher] agente corriendo · backend=${res.backend} · ${res.ref}`)
}

// ---- CLI (solo si este archivo es el entrypoint) ----
import { pathToFileURL } from 'node:url'
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [pageId, agentName, ...rest] = process.argv.slice(2)
  if (!pageId || !agentName) {
    console.error('uso: launcher.ts <page_id> <agent_name> [--mode column|mention|created] [--hop N] [--comment-b64 <b64>] [--creator <user_id>]')
    process.exit(1)
  }
  const flag = (name: string) => {
    const idx = rest.indexOf(`--${name}`)
    return idx >= 0 ? rest[idx + 1] : undefined
  }
  const opts: RunPhaseOptions = {
    mode: (flag('mode') as RunPhaseOptions['mode']) ?? 'column',
    hop: flag('hop') ? Number(flag('hop')) : 0,
    triggerComment: flag('comment-b64') ? Buffer.from(flag('comment-b64')!, 'base64').toString('utf8') : undefined,
    creatorId: flag('creator'),
  }
  try {
    runPhase(pageId, agentName, opts)
  } catch (err) {
    // aborto limpio ANTES de lanzar agente → exit 2 (el server libera el lock)
    console.error(`[launcher] ${(err as Error).message}`)
    const brand = (() => { try { return loadBridge().config.name } catch { return 'regent' } })()
    try { execFileSync(NCARD, ['comment', pageId, `⚠️ ${brand}: no pude lanzar la fase. ${(err as Error).message}`]) } catch { /* sin token */ }
    process.exit(2)
  }
}
