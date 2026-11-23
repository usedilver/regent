import fs from 'node:fs'

const CREATION_TIMEOUT_MS = 120000

/**
 * WorktreeCreate hook: the running core decides where the conversation's worktree lives and
 * creates it from the project root, so the directory the CLI session stands in never matters.
 */
async function worktreePath(name) {
  const toolsUrl = process.env.REGENT_TOOLS_URL
  if (!toolsUrl) throw new Error('This worktree belongs to a Regent run, and none is active.')

  const response = await fetch(toolsUrl.replace(/\/tools$/, '/worktree'), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.REGENT_RUN_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(CREATION_TIMEOUT_MS),
  })
  const body = await response.json().catch(() => ({}))

  if (!response.ok) throw new Error(body.error ?? `Core worktree HTTP ${response.status}`)
  if (typeof body.path !== 'string') throw new Error('Respuesta de worktree invalida.')
  return body.path
}

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'))
  console.log(await worktreePath(input.name))
} catch (error) {
  console.error(`Regent worktree: ${error.message}`)
  process.exitCode = 2
}
