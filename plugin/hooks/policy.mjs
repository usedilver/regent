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
  if (['status', 'ask_human', 'cancel', 'worktree', 'install', 'run_tests', 'open_pr', 'close_pr', 'create_task', 'update_task', 'request_qa'].some(tool => name === `mcp__regent__regent_${tool}`)) return null
  if (name === 'Bash') {
    const command = args.command ?? ''
    const native = env.REGENT_PERMISSION_MODE === 'repository'
    // Security floor (both modes): never read credentials, never pipe a download into an interpreter,
    // never recursively delete an absolute or home path (a worktree rm is fine).
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
    const first = words ? words[0] : (command.trim().match(/^[^\s|&;<>()`$]+/) ?? [''])[0]
    // Tracker and worktree publication go through the core tools, never direct.
    if (['ncard', 'regent-wt'].includes(first)) return 'ncard y regent-wt van por las tools del core, no por Bash.'
    // git/gh: reads allowed in both modes; writes go through the core publication tools.
    if (first === 'git' || first === 'gh') {
      if (!words) return 'Para git/gh usa un comando literal de lectura, sin operadores; la publicacion va por las tools del core.'
      if (/\.credentials\.json|\.env\b|\.claude\.json/.test(words.join(' '))) return 'No leer credenciales mediante git o gh.'
      if (first === 'git') {
        let index = 1
        if (words[index] === '-C') {
          const root = fs.realpathSync(env.REGENT_ROOT)
          let dir
          try { dir = fs.realpathSync(path.resolve(env.REGENT_CWD ?? root, words[index + 1] ?? '')) } catch { return 'Directorio git inexistente.' }
          const relative = path.relative(root, dir)
          if (relative.startsWith('..') || path.isAbsolute(relative)) return 'git -C debe consultar un repo dentro del workspace.'
          index += 2
        }
        const readOnly = ['log', 'show', 'blame', 'status', 'diff', 'ls-files', 'ls-tree', 'rev-parse', 'grep', 'show-ref', 'cat-file', 'describe', 'rev-list', 'shortlog']
        if (words[index] === 'submodule' && words[index + 1] === 'status' && words.slice(index + 2).every(w => ['--recursive', '--cached'].includes(w))) return null
        if (!readOnly.includes(words[index])) return 'Subcomando git de escritura: usa las tools del core para publicar.'
        if (words[index] === 'cat-file') {
          const [mode, object, ...extra] = words.slice(index + 1)
          if (!['-p', '-t', '-s', '-e', 'blob', 'tree', 'commit', 'tag'].includes(mode) || !object || object.startsWith('-') || extra.length) {
            return 'cat-file solo admite inspeccion directa: -p, -t, -s, -e o tipo de objeto, seguido de un objeto; sin filtros ni modos batch.'
          }
        }
        if (words.some(w => /^--(?:output|open-files-in-pager|ext-diff|textconv|no-index|exec|config)/.test(w) || /^-O/.test(w))) return 'Opcion git no permitida en una consulta de lectura.'
        return null
      }
      if (['pr', 'issue', 'repo'].includes(words[1]) && ['view', 'list', 'diff'].includes(words[2]) && !words.some(w => /^--(?:web|template)/.test(w))) return null
      return 'gh de escritura: usa las tools del core para publicar.'
    }
    // Any other command: bypass runs it (this hook is the guard); native lets the repo settings decide.
    void native
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
  if (name.startsWith('mcp__')) return null
  if (['Task', 'WebFetch', 'WebSearch', 'TodoWrite'].includes(name)) return null
  if (env.REGENT_PERMISSION_MODE === 'repository') return null
  return `${name}: herramienta no habilitada. Los cambios requieren un worktree propio y la autorizacion del core.`
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
