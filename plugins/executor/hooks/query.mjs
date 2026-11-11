import fs from 'node:fs'
import { parse } from 'shell-quote'
import { inside, resolveTarget } from './paths.mjs'

const REGENT_PREFIX = 'mcp__regent__regent_'
const editors = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const shells = new Set(['Bash', 'PowerShell', 'Monitor'])
const relocators = new Set(['EnterWorktree', 'ExitWorktree'])
const HEREDOC_BODY = /(<<-?\s*(['"]?)(\w+)\2[^\n]*)\n[\s\S]*?\n\s*\3\b/g
const PROJECT_WRITE =
  'Query mode cannot write project files; code changes require an editing request. Write scratch files under the system temporary directory.'
const COMMAND_START = String.raw`(?:^|[\s;&|(\`])`
const GIT_OPTIONS = String.raw`(?:(?:-[cC]\s+\S+|--?[\w-]+(?:=\S+)?)\s+)*`
const GIT_WRITE = new RegExp(
  COMMAND_START +
    String.raw`git\s+` +
    GIT_OPTIONS +
    String.raw`(?:add|am|apply|checkout|cherry-pick|clean|commit|merge|mv|pull|push|rebase|reset|restore|revert|rm|stash|switch|tag|branch\s+-[a-zA-Z]|worktree\s+(?:add|remove|move|prune)|submodule\s+(?:add|update|init|deinit))\b`,
)
const GH_WRITE = new RegExp(
  COMMAND_START +
    String.raw`gh\s+(?:pr|issue|release|repo|workflow|run)\s+(?:create|merge|close|reopen|edit|comment|review|delete|rename|sync|run|rerun|cancel|ready)\b`,
)
const internal = new Set([
  'read_history',
  'get_attachment',
  'git_read',
  'use_repo',
  'create_room',
  'status',
  'ask_human',
  'cancel',
])
const sqlExecutors = new Set(['execute_sql', 'execute_query', 'run_sql_query'])
/** Vendor-specific names that read despite not looking like it. */
const readerAliases = {
  post_search: 'search',
  post_database_query: 'query_database',
  post_query_a_data_source: 'query_data_source',
}
const READER_NAME =
  /^(?:get|list|read|search|query|select|describe|show|explain|count|fetch|inspect|find|audit|report)(?:_|$)/
const READER_SUFFIX = /_(?:query|report|search|read|list)$/
const WRITER_NAME =
  /(?:^|_)(?:write|update|create|delete|remove|modify|upsert|insert|set|execute|run|sync)(?:_|$)/
const SQL_TOOL = /(?:sql|db|database|warehouse|graphql)/
const SQL_VERB = /^(?:query|select|explain)(?:_|$)/
const SQL_FIELDS = ['sql', 'sqlquery', 'statement']
const READ_ONLY_SQL = /^\s*(?:select|with|explain|show|describe)\b/i
const mutations =
  /\b(?:insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|execute|copy|into|set|mutation)\b/i
const MAX_INSPECTED_FIELDS = 10000

/** The operation part of `mcp__server__tool`, normalized for the name heuristics. */
function mcpOperation(name) {
  const tool = name
    .split('__')
    .slice(2)
    .join('_')
    .replace(/^API[-_]/i, '')
    .replaceAll('-', '_')
    .toLowerCase()

  return readerAliases[tool] ?? tool
}

// Read-oriented names are a trusted service contract, not an OS/DB sandbox.
function isReader(tool) {
  const reads = READER_NAME.test(tool) || READER_SUFFIX.test(tool)
  return reads && !WRITER_NAME.test(tool)
}

/** Walks the arguments for SQL-like fields and rejects anything that is not a plain read. */
function sqlArgumentDenial(root, sqlExecutor, sqlTool) {
  const pending = [root]
  let inspected = 0
  let sqlArguments = 0

  while (pending.length) {
    const object = pending.pop()
    if (!object || typeof object !== 'object') continue

    for (const [key, value] of Object.entries(object)) {
      if (++inspected > MAX_INSPECTED_FIELDS) return 'Query arguments exceed the inspection limit.'
      if (value && typeof value === 'object') pending.push(value)
      if (typeof value !== 'string') continue
      const field = key.replaceAll('_', '').replaceAll('-', '').toLowerCase()
      if (!SQL_FIELDS.includes(field) && !(field === 'query' && sqlTool)) continue
      sqlArguments++

      if (mutations.test(value) || (sqlExecutor && !READ_ONLY_SQL.test(value))) {
        return 'Mutating queries are not enabled in query mode.'
      }
    }
  }

  // SQL execution wrappers additionally require actual read-only SQL arguments.
  if (sqlExecutor && !sqlArguments) return 'A SQL reader requires a read-only SQL argument.'
  return null
}

/** Whether a path lies in a scratch location a query may write, never in the project. */
function isScratch(file, env) {
  try {
    const within = (roots) =>
      roots.some((root) => fs.existsSync(root) && inside(fs.realpathSync(root), target))
    const target = resolveTarget(env.REGENT_CWD ?? env.REGENT_ROOT ?? process.cwd(), file)
    // The repository workspace stays protected even when it sits under a scratch location.
    if (within(JSON.parse(env.REGENT_QUERY_PROTECTED ?? '[]'))) return false
    return within(JSON.parse(env.REGENT_QUERY_WRITABLE ?? '[]'))
  } catch {
    // An unreadable location is treated like the project: not writable from a query.
    return false
  }
}

function scratchEditDenial(args, env) {
  const file = args.file_path ?? args.notebook_path
  if (typeof file !== 'string' || !file) return 'Indica la ruta del archivo.'
  return isScratch(file, env) ? null : PROJECT_WRITE
}

/** A literal output redirection aimed outside the scratch locations. Heuristic, like every guard here. */
function redirectsIntoProject(command, env) {
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
    return !isScratch(target, env)
  })
}

/**
 * Commands run freely in a query, except the ones that change Git state, publish work or
 * plainly redirect output into the project.
 */
function commandDenial(command, env) {
  if (typeof command !== 'string') return null

  if (GIT_WRITE.test(command) || GH_WRITE.test(command)) {
    return 'Query mode cannot change Git state or publish. Use regent_git_read for history and diffs; code changes require an editing request.'
  }

  return redirectsIntoProject(command, env) ? PROJECT_WRITE : null
}

/**
 * Why a tool call is not allowed in query mode, or null when it is. A query investigates with
 * every native tool, including shells and scratch files, but never edits the project, changes
 * Git state, publishes or mutates through MCP.
 */
export function queryDenial(input, env = process.env) {
  const name = input.tool_name ?? ''
  if (editors.has(name)) return scratchEditDenial(input.tool_input ?? {}, env)
  if (shells.has(name)) return commandDenial(input.tool_input?.command, env)
  if (relocators.has(name)) return 'Query mode keeps the conversation in its current location.'

  if (name.startsWith(REGENT_PREFIX)) {
    if (internal.has(name.slice(REGENT_PREFIX.length))) return null
    return 'Query mode cannot change files or start processes.'
  }

  if (!name.startsWith('mcp__')) return null

  const tool = mcpOperation(name)
  const sqlExecutor = sqlExecutors.has(tool)
  if (!sqlExecutor && !isReader(tool)) return 'This MCP operation is not enabled in query mode.'
  const sqlTool = SQL_TOOL.test(tool) || SQL_VERB.test(tool)
  return sqlArgumentDenial(input.tool_input ?? {}, sqlExecutor, sqlTool)
}
