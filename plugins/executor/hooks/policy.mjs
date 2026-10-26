import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { queryDenial } from './query.mjs'
import { literalCommand } from './command.mjs'

const WORKSPACE_PREPARATION_TIMEOUT_MS = 240000
const CREDENTIAL_FILES = /\.credentials\.json|\.claude\.json/
const READERS = ['Read', 'Glob', 'Grep']
const EDITORS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']
const INTERNAL_TOOLS = ['use_repo', 'create_room', 'status', 'ask_human', 'cancel'].map(
  (tool) => `mcp__regent__regent_${tool}`,
)
const DOWNLOAD_TO_INTERPRETER =
  /\b(?:curl|wget|fetch)\b[\s\S]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|ash|dash|python[0-9.]*|node|perl|ruby)\b/
const RM_INVOCATION = /(?:^|[;&|]\s*|\s)rm\s+([^;&|]+)/
const ABSOLUTE_OR_HOME = /^(?:\/|~|\$HOME|\$\{HOME\})/
const SQL_MUTATION =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|execute|copy|into|set)\b/i

const inside = (root, target) => {
  const relative = path.relative(root, target)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/**
 * The reason a tool call is denied, or null to abstain. These are heuristic guards in both
 * permission modes, not a sandbox: credentials, download-to-interpreter pipelines, recursive
 * deletes of absolute paths, read-only MCP mutations and edits outside the workspace.
 */
export function denial(input, env = process.env) {
  const name = input.tool_name ?? ''
  const args = input.tool_input ?? {}

  if (env.REGENT_READ_ONLY === '1') {
    const reason = queryDenial(input)
    if (reason) return reason
  }

  if (name === 'Skill') return null
  if (READERS.includes(name)) return readDenial(name, args)
  if (EDITORS.includes(name)) return editDenial(args, env)
  if (INTERNAL_TOOLS.includes(name)) return null
  if (name === 'Bash') return bashDenial(args.command ?? '')
  return readonlyMcpDenial(name, input, env)
}

function readDenial(name, args) {
  const paths = [args.file_path, args.path, name === 'Glob' ? args.pattern : null, args.glob]

  if (CREDENTIAL_FILES.test(JSON.stringify(paths.filter(Boolean)))) {
    return 'No leer archivos de credenciales; consulta codigo sin secretos.'
  }

  return null
}

/** The real location of a path that may not exist yet: its nearest existing ancestor, resolved. */
function resolveTarget(cwd, file) {
  const requested = path.resolve(cwd, file)
  let parent = requested

  while (true) {
    try {
      fs.lstatSync(parent)
      break
    } catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(parent) === parent) throw error
      parent = path.dirname(parent)
    }
  }

  return path.resolve(fs.realpathSync(parent), path.relative(parent, requested))
}

function editDenial(args, env) {
  const file = args.file_path ?? args.notebook_path
  if (typeof file !== 'string' || !file) return 'Indica la ruta del archivo.'

  // The project's .env/.env.local are the agent's own build config, and core.permission already
  // confines Write/Edit to the worktree, so it can only touch its own. Hard credentials, never.
  if (CREDENTIAL_FILES.test(file)) {
    return 'No modificar archivos de credenciales mediante herramientas de edicion.'
  }

  try {
    const root = fs.realpathSync(env.REGENT_ROOT)
    const resolved = resolveTarget(env.REGENT_CWD ?? root, file)

    if (CREDENTIAL_FILES.test(resolved)) {
      return 'No modificar archivos de credenciales mediante herramientas de edicion.'
    }

    if (!inside(root, resolved)) return 'La edicion debe estar dentro del workspace autorizado.'
    return null
  } catch {
    return 'Ruta de edicion inaccesible o workspace no configurado.'
  }
}

/** `rm -rf` (in any flag spelling) aimed at an absolute path or the home directory. */
function recursiveRootDelete(command) {
  const match = command.match(RM_INVOCATION)
  if (!match) return false
  const parts = match[1].trim().split(/\s+/)
  const flags = parts.filter((part) => part.startsWith('-')).join('')
  const targets = parts.filter((part) => !part.startsWith('-'))
  return /r/i.test(flags) && /f/i.test(flags) && targets.some((t) => ABSOLUTE_OR_HOME.test(t))
}

function bashDenial(command) {
  if (CREDENTIAL_FILES.test(command)) return 'No leer archivos de credenciales.'
  if (DOWNLOAD_TO_INTERPRETER.test(command)) return 'No canalizar una descarga a un interprete.'
  if (recursiveRootDelete(command)) return 'No borrar recursivamente rutas absolutas o del home.'
  const words = literalCommand(command)

  if (words && CREDENTIAL_FILES.test(words.join(' '))) {
    return 'No leer archivos de credenciales.'
  }

  // Git, gh and repository scripts follow the same runtime permissions as other
  // shell tools. In bypass mode this abstention is not a filesystem sandbox.
  return null
}

function readonlyMcpDenial(name, input, env) {
  let servers = []

  try {
    servers = JSON.parse(env.REGENT_READONLY_MCP ?? '[]')
  } catch {
    return 'Configuracion readonly_mcp invalida.'
  }

  if (servers.some((server) => name.startsWith(`mcp__${server}__`))) {
    const reason = queryDenial(input)
    if (reason) return reason

    if (SQL_MUTATION.test(JSON.stringify(input.tool_input ?? {}))) {
      return 'El MCP esta marcado readonly: DML/DDL no permitido.'
    }

    return null
  }

  // The repo is the source of truth: its MCP tools, the user's, and the built-in meta tools
  // (ToolSearch, Task, WebFetch, WebSearch, TodoWrite...) are trusted context. The real guards
  // ran above: credentials, read-only MCP DML and workspace-scoped edits. Abstain here, so
  // bypass runs the call and native lets the repo decide.
  return null
}

// Hook entrypoint

/** Asks the running core, which knows the worktree and the run state, instead of deciding locally. */
async function remoteDenial(input, toolsUrl) {
  const response = await fetch(toolsUrl.replace(/\/tools$/, '/tool-policy'), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.REGENT_RUN_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(WORKSPACE_PREPARATION_TIMEOUT_MS),
  })

  if (!response.ok) throw new Error(`Core policy HTTP ${response.status}`)
  const { reason } = await response.json()

  if (reason !== null && typeof reason !== 'string') {
    throw new Error('Respuesta de permisos invalida.')
  }

  return reason
}

async function main() {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'))
    const reason = process.env.REGENT_TOOLS_URL
      ? await remoteDenial(input, process.env.REGENT_TOOLS_URL)
      : denial(input)

    if (reason) {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        }),
      )
    }
  } catch (error) {
    console.error(`Regent policy: ${error.message}`)
    process.exitCode = 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
