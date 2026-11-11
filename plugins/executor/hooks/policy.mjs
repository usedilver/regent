import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parse } from 'shell-quote'
import { literalCommand } from './command.mjs'
import { inside, resolveTarget } from './paths.mjs'
import { readerDenial } from './readers.mjs'

const WORKSPACE_PREPARATION_TIMEOUT_MS = 240000
const CREDENTIAL_FILES = /\.credentials\.json|\.claude\.json/
const READERS = ['Read', 'Glob', 'Grep']
const EDITORS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']
const SHELLS = ['Bash', 'PowerShell', 'Monitor']
const INTERNAL_TOOLS = [
  'use_repo',
  'create_room',
  'status',
  'ask_human',
  'cancel',
  'cleanup_worktree',
].map((tool) => `mcp__regent__regent_${tool}`)
const DOWNLOAD_TO_INTERPRETER =
  /\b(?:curl|wget|fetch)\b[\s\S]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|ash|dash|python[0-9.]*|node|perl|ruby)\b/
const RM_INVOCATION = /(?:^|[;&|]\s*|\s)rm\s+([^;&|]+)/
const ABSOLUTE_OR_HOME = /^(?:\/|~|\$HOME|\$\{HOME\})/
const HEREDOC_BODY = /(<<-?\s*(['"]?)(\w+)\2[^\n]*)\n[\s\S]*?\n\s*\3\b/g
const COMMAND_START = String.raw`(?:^|[\s;&|(\`])`
const GIT_OPTIONS = String.raw`(?:(?:-[cC]\s+\S+|--?[\w-]+(?:=\S+)?)\s+)*`
/** Git commands that move a checkout's branch, index or files. Fetch and pull keep it current. */
const GIT_STATE = new RegExp(
  COMMAND_START +
    String.raw`git\s+` +
    GIT_OPTIONS +
    String.raw`(?:add|am|apply(?!\s+--(?:check|stat|numstat|summary)\b)|checkout|cherry-pick|clean|commit|merge|mv|push|rebase|reset|restore|revert|rm|switch|stash(?!\s+(?:list|show)\b)|branch\s+(?:-[dDmMcCf]+|--(?:delete|move|copy|force))|worktree\s+(?:add|remove|move|prune))(?![\w-])`,
)
const PACKAGE_INSTALL = new RegExp(
  COMMAND_START +
    String.raw`(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|remove|rm|uninstall|update|upgrade|up|link)(?![\w-])`,
)
/** Installs that reproduce the committed lockfile only bring a pulled checkout up to date. */
const LOCKED_INSTALL = /--frozen-lockfile\b|--immutable\b/
const GH_CHECKOUT = new RegExp(COMMAND_START + String.raw`gh\s+pr\s+checkout(?![\w-])`)
const SQL_MUTATION =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|execute|copy|into|set)\b/i

/**
 * The reason a tool call is denied, or null to abstain. These are heuristic guards in both
 * permission modes, not a sandbox: credentials, download-to-interpreter pipelines, recursive
 * deletes of absolute paths, read-only MCP mutations, edits outside the conversation's worktree
 * and commands that would disturb the checkout every conversation shares.
 */
export function denial(input, env = process.env) {
  const name = input.tool_name ?? ''
  const args = input.tool_input ?? {}
  if (name === 'Skill') return null
  if (READERS.includes(name)) return readDenial(name, args)
  if (EDITORS.includes(name)) return editDenial(args, env)
  if (INTERNAL_TOOLS.includes(name)) return null
  if (SHELLS.includes(name)) return bashDenial(args.command ?? '', env)
  return readonlyMcpDenial(name, input, env)
}

function readDenial(name, args) {
  const paths = [args.file_path, args.path, name === 'Glob' ? args.pattern : null, args.glob]

  if (CREDENTIAL_FILES.test(JSON.stringify(paths.filter(Boolean)))) {
    return 'No leer archivos de credenciales; consulta codigo sin secretos.'
  }

  return null
}

/** Scratch locations stay writable from anywhere: temporary files and downloaded attachments. */
function scratchRoots(env) {
  try {
    return JSON.parse(env.REGENT_SCRATCH ?? '[]').filter((root) => fs.existsSync(root))
  } catch {
    return []
  }
}

/** How to reach an editable place, for an edit or redirection that missed it. */
function worktreeHint(env) {
  if (env.REGENT_ROOT) return 'La edicion debe estar dentro del workspace autorizado.'

  return env.REGENT_WORKTREE_NAME
    ? `Repository code changes belong in this conversation's worktree. Call EnterWorktree with name "${env.REGENT_WORKTREE_NAME}" first, then edit there. Scratch files go under the system temporary directory.`
    : 'No hay un worktree aislado disponible. Selecciona un repo Git con regent_use_repo; no edites el checkout compartido.'
}

/** Edits land in the conversation's worktree (REGENT_ROOT, once entered) or a scratch location. */
function editable(target, env) {
  const roots = scratchRoots(env).map((root) => fs.realpathSync(root))
  const worktree = env.REGENT_ROOT ? fs.realpathSync(env.REGENT_ROOT) : undefined
  if (worktree && inside(worktree, target)) return true
  // The repository workspace stays protected even when it sits under a scratch location.
  if (env.REGENT_WORKSPACE && inside(fs.realpathSync(env.REGENT_WORKSPACE), target)) return false
  return roots.some((root) => inside(root, target))
}

function editDenial(args, env) {
  const file = args.file_path ?? args.notebook_path
  if (typeof file !== 'string' || !file) return 'Indica la ruta del archivo.'

  // The project's .env/.env.local are the agent's own build config, and edits are confined to
  // the conversation's worktree, so it can only touch its own. Hard credentials, never.
  if (CREDENTIAL_FILES.test(file)) {
    return 'No modificar archivos de credenciales mediante herramientas de edicion.'
  }

  try {
    const resolved = resolveTarget(env.REGENT_CWD ?? env.REGENT_ROOT ?? process.cwd(), file)

    if (CREDENTIAL_FILES.test(resolved)) {
      return 'No modificar archivos de credenciales mediante herramientas de edicion.'
    }

    return editable(resolved, env) ? null : worktreeHint(env)
  } catch {
    return 'Ruta de edicion inaccesible o workspace no configurado.'
  }
}

/** A literal output redirection aimed outside the worktree and the scratch locations. */
function redirectsElsewhere(command, env) {
  let words

  try {
    words = parse(command.replace(HEREDOC_BODY, '$1'), (name) => `\${${name}}`)
  } catch {
    return false
  }

  return words.some((word, index) => {
    const target = words[index + 1]
    if (word?.op !== '>' && word?.op !== '>>') return false
    if (typeof target !== 'string' || /[$`]/.test(target) || target.startsWith('/dev/'))
      return false

    try {
      return !editable(resolveTarget(env.REGENT_CWD ?? process.cwd(), target), env)
    } catch {
      return true
    }
  })
}

/**
 * The command as the shell sees it, without heredoc bodies and with multi-word quoted arguments
 * blanked, so text that merely mentions a command is not mistaken for running it.
 */
function commandSkeleton(command) {
  const text = command.replace(HEREDOC_BODY, '$1')

  try {
    return parse(text, (name) => `\${${name}}`)
      .map((word) =>
        typeof word === 'string' ? (/\s/.test(word) ? "'…'" : word) : (word.op ?? ''),
      )
      .join(' ')
  } catch {
    return text
  }
}

/**
 * The checkout every conversation reads keeps its branch, index and dependencies: a command
 * run there may read, build and fetch, but not move Git state or reinstall packages.
 */
function sharedCheckoutDenial(command, env) {
  if (env.REGENT_SHARED !== '1') return null
  const text = commandSkeleton(command)
  const where = env.REGENT_WORKTREE_NAME
    ? ` Call EnterWorktree with name "${env.REGENT_WORKTREE_NAME}" and run it there.`
    : ''

  if (GIT_STATE.test(text) || GH_CHECKOUT.test(text)) {
    return `Every conversation reads this checkout: do not change its Git state.${where}`
  }

  if (PACKAGE_INSTALL.test(text) && !LOCKED_INSTALL.test(text)) {
    return `Every conversation reads this checkout: do not change its dependencies.${where}`
  }

  return null
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

function bashDenial(command, env) {
  if (typeof command !== 'string') return null
  if (CREDENTIAL_FILES.test(command)) return 'No leer archivos de credenciales.'
  if (DOWNLOAD_TO_INTERPRETER.test(command)) return 'No canalizar una descarga a un interprete.'
  if (recursiveRootDelete(command)) return 'No borrar recursivamente rutas absolutas o del home.'
  const words = literalCommand(command)

  if (words && CREDENTIAL_FILES.test(words.join(' '))) {
    return 'No leer archivos de credenciales.'
  }

  // The core supplies these locations; a bare hook without them only applies the guards above.
  if (env.REGENT_SCRATCH === undefined) return null
  if (redirectsElsewhere(command, env)) return worktreeHint(env)
  // Elsewhere Git, gh and repository scripts follow the same runtime permissions as other
  // shell tools. In bypass mode this abstention is not a filesystem sandbox.
  return sharedCheckoutDenial(command, env)
}

function readonlyMcpDenial(name, input, env) {
  let servers = []

  try {
    servers = JSON.parse(env.REGENT_READONLY_MCP ?? '[]')
  } catch {
    return 'Configuracion readonly_mcp invalida.'
  }

  if (servers.some((server) => name.startsWith(`mcp__${server}__`))) {
    const reason = readerDenial(input)
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
