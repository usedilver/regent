type Task = { runId?: string; running: boolean; background: boolean; ambient: boolean }

const terminalStatuses = new Set(['completed', 'failed', 'killed', 'stopped'])
const taskId = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** The CLI's live snapshot is authoritative; lifecycle events support older CLI versions. */
export class BackgroundTasks {
  private snapshot?: Set<string>
  private tasks = new Map<string, Task>()
  private shellCalls = new Set<string>()

  get running(): boolean {
    if (this.snapshot) return this.snapshot.size > 0
    return [...this.tasks.values()].some((task) => task.running && task.background && !task.ambient)
  }

  observe(raw: any): void {
    if (raw.type === 'system' && raw.subtype === 'background_tasks_changed') {
      if (!Array.isArray(raw.tasks) || !raw.tasks.every((task: any) => taskId(task?.task_id)))
        return
      this.snapshot = new Set(
        raw.tasks.filter((task: any) => task.ambient !== true).map((task: any) => task.task_id),
      )
      this.tasks.clear()
      this.shellCalls.clear()
      return
    }

    if (this.snapshot) return
    if (raw.type === 'system') this.lifecycle(raw)
    if (raw.type === 'assistant') this.rememberShellCalls(raw)
    if (raw.type === 'user') this.shellResult(raw)
  }

  private lifecycle(raw: any): void {
    if (!taskId(raw.task_id)) return
    const previous = this.tasks.get(raw.task_id)
    const runId = taskId(raw.run_id) ? raw.run_id : undefined
    if (runId && previous?.runId && runId < previous.runId) return

    if (raw.subtype === 'task_started') {
      if (runId && previous && previous.runId === runId && !previous.running) return
      this.tasks.set(raw.task_id, {
        runId,
        running: true,
        background: raw.is_backgrounded !== false,
        ambient: raw.ambient === true,
      })
      return
    }

    const status = raw.subtype === 'task_notification' ? raw.status : raw.patch?.status
    if (!['task_updated', 'task_notification'].includes(raw.subtype)) return
    if (terminalStatuses.has(status)) {
      this.tasks.set(raw.task_id, {
        runId: runId ?? previous?.runId,
        running: false,
        background: false,
        ambient: previous?.ambient ?? raw.ambient === true,
      })
      return
    }

    if (raw.subtype === 'task_updated' && previous) {
      this.tasks.set(raw.task_id, {
        ...previous,
        ...(typeof raw.patch?.is_backgrounded === 'boolean'
          ? { background: raw.patch.is_backgrounded }
          : {}),
      })
    }
  }

  private rememberShellCalls(raw: any): void {
    if (!Array.isArray(raw.message?.content)) return
    for (const block of raw.message.content) {
      if (block.type === 'tool_use' && ['Bash', 'PowerShell'].includes(block.name)) {
        this.shellCalls.add(JSON.stringify([raw.parent_tool_use_id ?? null, block.id]))
      }
    }
  }

  private shellResult(raw: any): void {
    if (!Array.isArray(raw.message?.content)) return
    for (const block of raw.message.content) {
      if (block.type !== 'tool_result') continue
      const known = this.shellCalls.delete(
        JSON.stringify([raw.parent_tool_use_id ?? null, block.tool_use_id]),
      )
      const id = raw.tool_use_result?.backgroundTaskId
      if (!known || block.is_error || !taskId(id)) continue
      const previous = this.tasks.get(id)
      if (previous && !previous.running) continue
      this.tasks.set(id, {
        ...previous,
        running: true,
        background: true,
        ambient: previous?.ambient ?? false,
      })
    }
  }
}
