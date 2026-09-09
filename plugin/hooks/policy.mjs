import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { literalCommand } from './command.mjs'

export function denial(input, env = process.env) {
  const name = input.tool_name ?? ''
  const args = input.tool_input ?? {}
  if (name === 'Skill') return null
  if (['Read', 'Glob', 'Grep'].includes(name)) {
    const paths = [args.file_path, args.path, name === 'Glob' ? args.pattern : null, args.glob].filter(Boolean)
    if (/\.credentials\.json|\.env(?:\b|$)|\.claude\.json/.test(JSON.stringify(paths))) return 'No leer archivos de credenciales; consulta codigo sin secretos.'
    return null
  }
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) {
    const file = args.file_path ?? args.notebook_path
    if (typeof file !== 'string' || !file) return 'Indica la ruta del archivo.'
    if (/\.credentials\.json|\.env(?:\b|$)|\.claude\.json/.test(file)) return 'No modificar archivos de credenciales mediante herramientas de edicion.'
    try {
      const root = fs.realpathSync(env.REGENT_ROOT)
      const requested = path.resolve(env.REGENT_CWD ?? root, file)
      let parent = requested
      while (true) {
        try { fs.lstatSync(parent); break } catch (error) {
          if (error.code !== 'ENOENT' || path.dirname(parent) === parent) throw error
          parent = path.dirname(parent)
        }
      }
      const resolved = path.resolve(fs.realpathSync(parent), path.relative(parent, requested))
      if (/\.credentials\.json|\.env(?:\b|$)|\.claude\.json/.test(resolved)) return 'No modificar archivos de credenciales mediante herramientas de edicion.'
      const relative = path.relative(root, resolved)
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return 'La edicion debe estar dentro del workspace autorizado.'
      return null
    } catch { return 'Ruta de edicion inaccesible o workspace no configurado.' }
  }
  if (['use_repo', 'create_room', 'status', 'ask_human', 'cancel'].some(tool => name === `mcp__regent__regent_${tool}`)) return null
  if (name === 'Bash') {
    const command = args.command ?? ''
    // Heuristic guards in both modes, not a shell sandbox: credential references,
    // download-to-interpreter pipelines and recursive deletion of absolute paths.
    if (/\.credentials\.json|\.env(?:\b|$)|\.claude\.json/.test(command)) return 'No leer archivos de credenciales.'
    if (/\b(?:curl|wget|fetch)\b[\s\S]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|ash|dash|python[0-9.]*|node|perl|ruby)\b/.test(command)) return 'No canalizar una descarga a un interprete.'
    const rmMatch = command.match(/(?:^|[;&|]\s*|\s)rm\s+([^;&|]+)/)
    if (rmMatch) {
      const parts = rmMatch[1].trim().split(/\s+/)
      const flags = parts.filter(a => a.startsWith('-')).join('')
      const targets = parts.filter(a => !a.startsWith('-'))
      if (/r/i.test(flags) && /f/i.test(flags) && targets.some(t => /^(?:\/|~|\$HOME|\$\{HOME\})/.test(t))) return 'No borrar recursivamente rutas absolutas o del home.'
    }
    const words = literalCommand(command)
    if (words && /\.credentials\.json|\.env\b|\.claude\.json/.test(words.join(' '))) return 'No leer archivos de credenciales.'
    // Git, gh and repository scripts follow the same runtime permissions as other
    // shell tools. In bypass mode this abstention is not a filesystem sandbox.
    return null
  }
  let servers = []
  try { servers = JSON.parse(env.REGENT_READONLY_MCP ?? '[]') } catch { return 'Configuracion readonly_mcp invalida.' }
  if (servers.some(server => name.startsWith(`mcp__${server}__`))) {
    const tool = name.split('__').slice(2).join('_')
    if (!/^(?:get|list|read|search|query|select|describe|show|explain|count)(?:_|$)/i.test(tool)) return 'Solo herramientas de consulta del MCP readonly.'
    const payload = JSON.stringify(args)
    if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|execute|copy|into|set)\b/i.test(payload)) return 'El MCP esta marcado readonly: DML/DDL no permitido.'
    return null
  }
  // El repo es la fuente de verdad: sus MCPs (y los del usuario) son contexto confiable.
  // Los servidores marcados en readonly_mcp ya quedaron restringidos arriba.
  // Repo/user MCP tools and every built-in meta tool (ToolSearch loads deferred MCP tools,
  // Task/WebFetch/WebSearch/TodoWrite, etc.) are the repo's context, not a threat. The real
  // guards are above: credentials, readonly MCP DML, and workspace-scoped edits.
  // Abstain here: bypass runs it, native lets the repo decide.
  return null
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'))
    let reason
    if (process.env.REGENT_TOOLS_URL) {
      const response = await fetch(process.env.REGENT_TOOLS_URL.replace(/\/tools$/, '/tool-policy'), {
        method: 'POST', headers: { authorization: `Bearer ${process.env.REGENT_RUN_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(input), signal: AbortSignal.timeout(3000),
      })
      if (!response.ok) throw new Error(`Core policy HTTP ${response.status}`)
      reason = (await response.json()).reason
      if (reason !== null && typeof reason !== 'string') throw new Error('Respuesta de permisos invalida.')
    } else reason = denial(input)
    if (reason) {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }))
    }
  } catch (error) { console.error(`Regent policy: ${error.message}`); process.exitCode = 2 }
}
