import type { Output } from '../../core/types.ts'
import type { Store } from '../../storage/store.ts'

export function mcpOutput(store: Store): Output {
  return {
    /** MCP clients poll; a notice is the latest progress text they read back. */
    async notice(conversation, text) {
      const run = store.latestRun(conversation.key)
      if (run) store.event(run.id, 'mcp_notice', { text })
    },
    async progress(conversation, run, text) {
      store.event(run.id, 'mcp_notice', { text })
    },
    async status() {},
    async delta() {},
    async finish() {},
    async question() {},
  }
}

export function routeMcpOutput(slack: Output, mcp: Output): Output {
  const target = (adapter: string) => (adapter === 'mcp' ? mcp : slack)
  return {
    activity(c, run, event) {
      target(c.adapter).activity?.(c, run, event)
    },
    animates(c) {
      return target(c.adapter).animates?.(c) ?? false
    },
    async notice(c, text) {
      await target(c.adapter).notice(c, text)
    },
    async status(c, status) {
      await target(c.adapter).status(c, status)
    },
    async delta(c, run, text) {
      await target(c.adapter).delta(c, run, text)
    },
    async finish(c, run, text, options) {
      await target(c.adapter).finish(c, run, text, options)
    },
    async question(c, question) {
      await target(c.adapter).question?.(c, question)
    },
    async progress(c, run, text) {
      await target(c.adapter).progress?.(c, run, text)
    },
    async recoverProgress() {
      await slack.recoverProgress?.()
    },
    async moved(run) {
      if (!run.conversation_key.startsWith('mcp:')) await slack.moved?.(run)
    },
    async flush() {
      await slack.flush?.()
    },
  }
}
