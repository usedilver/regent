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
        return 'This MCP server is read-only: mutating queries are not allowed.'
      }
    }
  }

  // SQL execution wrappers additionally require actual read-only SQL arguments.
  if (sqlExecutor && !sqlArguments) return 'A SQL reader requires a read-only SQL argument.'
  return null
}

/**
 * Why an MCP call breaks the reader contract of a server the operator marked read-only, or
 * null when it reads. Names and SQL arguments are conventions, not a database sandbox.
 */
export function readerDenial(input) {
  const name = input.tool_name ?? ''
  const tool = mcpOperation(name)
  const sqlExecutor = sqlExecutors.has(tool)
  if (!sqlExecutor && !isReader(tool))
    return 'This MCP server is read-only: the operation is not a reader.'
  const sqlTool = SQL_TOOL.test(tool) || SQL_VERB.test(tool)
  return sqlArgumentDenial(input.tool_input ?? {}, sqlExecutor, sqlTool)
}
