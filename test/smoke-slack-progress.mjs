import assert from 'node:assert/strict'
import { loadEnv } from '../src/env.ts'
import { loadConfig } from '../src/config.ts'
import { Store } from '../src/store.ts'
import { SlackActivities } from '../src/slack-activities.ts'

// Explicit opt-in: sends synthetic progress only to the requested authorized user.
const user = process.env.REGENT_SLACK_SMOKE_USER
if (!user) throw new Error('Set REGENT_SLACK_SMOKE_USER to an authorized Slack user ID')
loadEnv()
const config = loadConfig()
assert.ok(config.slack.allowed_users.includes(user))
const api = async (method, args) => {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args),
  })
  const data = await response.json()
  if (!data.ok) throw new Error(data.error)
  console.log(`${method}: ok`)
  return data
}
const auth = await api('auth.test', {})
assert.equal(auth.team_id, config.slack.workspace_team_id)
const root = await api('chat.postMessage', { channel: user, text: 'Prueba tecnica de progreso Regent. Solo actividades simuladas; no modifica proyectos ni consulta datos.' })
const store = new Store(':memory:')
try {
  const input = { adapter: 'slack', key: 'smoke', eventId: 'smoke', channel: root.channel, thread: root.ts, author: user, team: auth.team_id, text: 'synthetic' }
  const { runId } = store.accept(input, process.cwd(), 24)
  store.start(runId)
  const c = store.conversation(input.key), run = store.run(runId)
  const activities = new SlackActivities(api, store)
  activities.event(c, run, { kind: 'tool_use', id: 'synthetic-read', name: 'Read' })
  await activities.flush()
  assert.equal(activities.get(runId).mode, 'stream')
  await new Promise(r => setTimeout(r, 3500))
  activities.event(c, run, { kind: 'tool_result', id: 'synthetic-read' })
  await activities.flush()
  store.finish(runId, 'completed', '', '')
  activities.terminal(run)
  await new Promise(r => setTimeout(r, 3500))
  await activities.flush()
  const record = activities.get(runId)
  assert.equal(record.sent, record.revision)
  assert.equal(record.closed, true)
  console.log('Real Slack timeline stream and final task cards accepted')
} finally { store.close() }
