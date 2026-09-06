import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function denial(input, env = process.env) {
  const name = input.tool_name ?? ''
  const args = input.tool_input ?? {}
  if (name === 'Skill') return null
  if (['Read', 'Glob', 'Grep'].includes(name)) {
    if (/\.credentials\.json|\.env(?:\b|$)|\.claude\.json/.test(JSON.stringify(args))) return 'No leer archivos de credenciales; consulta codigo sin secretos.'
    return null
  }
  if (['status', 'ask_human', 'cancel', 'worktree', 'install', 'run_tests', 'open_pr', 'create_task', 'update_task', 'request_qa'].some(tool => name === `mcp__regent__regent_${tool}`)) return null
  if (name === 'Bash') {
    const command = args.command ?? ''
    if (/\.credentials\.json|\.env\b|\.claude\.json/.test(command)) return 'No leer credenciales mediante comandos git o gh.'
    // Mutating commands go through the core; Bash stays read-only.
    if (!/^[a-zA-Z0-9_./:@%+=, \-]+$/.test(command)) return 'Bash admite comandos simples de lectura, sin operadores de shell.'
    const words = command.trim().split(/\s+/)
    if (words[0] === 'git') {
      let index = 1
      if (words[index] === '-C') {
        const root = fs.realpathSync(env.REGENT_ROOT)
        let dir
        try { dir = fs.realpathSync(path.resolve(root, words[index + 1] ?? '')) } catch { return 'Directorio git inexistente.' }
        const relative = path.relative(root, dir)
        if (relative.startsWith('..') || path.isAbsolute(relative)) return 'git -C debe consultar un repo dentro del workspace.'
        index += 2
      }
      const readOnly = ['log', 'show', 'blame', 'status', 'diff', 'ls-files', 'ls-tree', 'rev-parse', 'grep', 'show-ref', 'cat-file', 'describe', 'rev-list', 'shortlog']
      if (!readOnly.includes(words[index])) return 'Usa las tools del core para modificar git.'
      // -O/--open-files-in-pager (git grep) and the diff-driver/config options can execute a program.
      if (words.some(w => /^--(?:output|open-files-in-pager|ext-diff|textconv|no-index|exec|config)/.test(w) || /^-O/.test(w))) return 'Opcion git no permitida en una consulta de lectura.'
      return null
    }
    if (words[0] === 'gh' && ['pr', 'issue', 'repo'].includes(words[1]) && ['view', 'list', 'diff'].includes(words[2]) && !words.some(w => /^--(?:web|template)/.test(w))) return null
    return 'Bash solo admite git y gh de lectura; usa las tools del core para instalar, verificar y publicar.'
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
