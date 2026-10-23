import { activityEvent, activityView, type ActivityState } from './activities.ts'
import type { Store } from './store.ts'
import type { Run } from './types.ts'

export function mcpActivities(store: Store, run: Run) {
  const state: ActivityState = { calls: {} }
  const rows = store.db
    .prepare(
      `SELECT kind, json_extract(data,'$.id') id,
    json_extract(data,'$.parentId') parentId, json_extract(data,'$.name') name,
    json_extract(data,'$.input.command') command, json_extract(data,'$.error') error,
    json_extract(data,'$.background') background
    FROM events WHERE run_id=? AND kind IN ('tool_use','tool_result') ORDER BY events.id`,
    )
    .all(run.id)
  for (const event of rows) activityEvent(state, { ...event, input: { command: event.command } })
  if (!['running', 'queued'].includes(run.state)) state.terminal = run.state
  return activityView(state)
}
