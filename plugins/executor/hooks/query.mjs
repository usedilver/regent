const readers = new Set(['Read', 'Glob', 'Grep', 'Skill', 'ToolSearch', 'WebFetch', 'WebSearch'])
const internal = new Set(['git_read', 'use_repo', 'create_room', 'status', 'ask_human', 'cancel'])
const sqlExecutors = new Set(['execute_sql', 'execute_query', 'run_sql_query'])
const mutations =
  /\b(?:insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|execute|copy|into|set|mutation)\b/i

export function queryDenial(input) {
  const name = input.tool_name ?? ''
  if (readers.has(name)) return null
  if (name === 'mcp__regent__regent_preview' && input.tool_input?.action === 'status') return null
  if (name.startsWith('mcp__regent__regent_'))
    return internal.has(name.slice('mcp__regent__regent_'.length))
      ? null
      : 'Query mode cannot change files or start previews.'
  if (!name.startsWith('mcp__'))
    return 'Query mode only permits readers. Use regent_git_read for Git history/diffs; code changes require an editing request.'

  let tool = name
    .split('__')
    .slice(2)
    .join('_')
    .replace(/^API[-_]/i, '')
    .replaceAll('-', '_')
    .toLowerCase()
  tool =
    {
      post_search: 'search',
      post_database_query: 'query_database',
      post_query_a_data_source: 'query_data_source',
    }[tool] ?? tool
  const sqlExecutor = sqlExecutors.has(tool)
  const reader =
    /^(?:get|list|read|search|query|select|describe|show|explain|count|fetch|inspect|find|audit|report)(?:_|$)/.test(
      tool,
    ) || /_(?:query|report|search|read|list)$/.test(tool)
  if (
    !sqlExecutor &&
    (!reader ||
      /(?:^|_)(?:write|update|create|delete|remove|modify|upsert|insert|set|execute|run|sync)(?:_|$)/.test(
        tool,
      ))
  )
    return 'This MCP operation is not enabled in query mode.'

  // Read-oriented names are a trusted service contract, not an OS/DB sandbox.
  // SQL execution wrappers additionally require actual read-only SQL arguments.
  const sqlQuery =
    /(?:sql|db|database|warehouse|graphql)/.test(tool) ||
    /^(?:query|select|explain)(?:_|$)/.test(tool)
  const pending = [input.tool_input ?? {}]
  let inspected = 0,
    sqlArguments = 0
  while (pending.length) {
    const object = pending.pop()
    if (!object || typeof object !== 'object') continue
    for (const [key, value] of Object.entries(object)) {
      if (++inspected > 10000) return 'Query arguments exceed the inspection limit.'
      if (value && typeof value === 'object') pending.push(value)
      const field = key.replaceAll('_', '').replaceAll('-', '').toLowerCase()
      if (
        typeof value !== 'string' ||
        !(['sql', 'sqlquery', 'statement'].includes(field) || (field === 'query' && sqlQuery))
      )
        continue
      sqlArguments++
      if (
        mutations.test(value) ||
        (sqlExecutor && !/^\s*(?:select|with|explain|show|describe)\b/i.test(value))
      )
        return 'Mutating queries are not enabled in query mode.'
    }
  }
  if (sqlExecutor && !sqlArguments) return 'A SQL reader requires a read-only SQL argument.'
  return null
}
