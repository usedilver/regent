import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

export async function checkReply(input, toolsUrl, token, request = fetch) {
  if (input.hook_event_name !== 'Stop') return null
  const response = await request(toolsUrl.replace(/\/tools$/, '/completion-check'), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ background_tasks: input.background_tasks }),
    signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) throw new Error(`Reply check HTTP ${response.status}`)
  const result = await response.json()
  if (result.decision === 'allow') return null
  if (result.decision !== 'block' || typeof result.reason !== 'string')
    throw new Error('Invalid reply check')
  return { decision: 'block', reason: result.reason }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'))
    const result = await checkReply(
      input,
      process.env.REGENT_TOOLS_URL,
      process.env.REGENT_RUN_TOKEN,
    )
    if (result) console.log(JSON.stringify(result))
  } catch {
    console.log(
      JSON.stringify({
        decision: 'block',
        reason:
          'Regent could not verify the saved reply. Retry regent_reply and end only after it confirms the complete response is stored.',
      }),
    )
  }
}
