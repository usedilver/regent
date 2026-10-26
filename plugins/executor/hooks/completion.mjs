import fs from 'node:fs'

const toolsUrl = process.env.REGENT_TOOLS_URL
if (toolsUrl) {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'))
    if (!input.agent_id) {
      const endpoint = new URL(toolsUrl)
      endpoint.pathname = '/completion-check'
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${process.env.REGENT_RUN_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ stop_hook_active: Boolean(input.stop_hook_active) }),
        signal: AbortSignal.timeout(12000),
      })
      if (!response.ok) throw new Error(`Core HTTP ${response.status}`)
      const result = await response.json()
      if (result.decision === 'block') {
        console.log(JSON.stringify({ decision: 'block', reason: result.reason }))
      }
    }
  } catch (error) {
    console.error(
      `Regent completion check unavailable; final delivery will be checked by core: ${error.message}`,
    )
  }
}
