export interface Inbound {
  adapter: 'slack' | 'cli'
  eventId: string
  key: string
  author: string
  text: string
  channel: string
  thread?: string
  replyThread?: string
  team?: string
  transcript?: string
  history?: import('./history.ts').HistorySource
  intent?: import('./intent.ts').Intent
  repo?: string
}

export interface Conversation {
  key: string
  adapter: string
  channel: string
  thread: string | null
  team: string | null
  author: string
  cwd: string
  state: string
  session_id: string | null
  updated_at: number
  task_id: string | null
}

export interface Run {
  id: string
  conversation_key: string
  author: string
  prompt: string
  transcript: string | null
  reply_thread: string | null
  reply_channel: string | null
  intent: import('./intent.ts').Intent
  state: string
  created_at: number
  result: string | null
  error: string | null
  cost: number
}

export interface Output {
  activity?(conversation: Conversation, run: Run, event: import('./runner.ts').RunnerEvent): void
  /** True when THIS conversation shows a native "working…" indicator (needs a thread anchor):
   * skip the periodic heartbeat there. Rooms converse at channel root with no anchor, so they
   * return false and rely on the updating progress message below. */
  animates?(conversation: Conversation): boolean
  question?(conversation: Conversation, question: { id: string; text: string; options: string[] }): Promise<void>
  notice(conversation: Conversation, text: string): Promise<void>
  status(conversation: Conversation, status: 'processing' | 'active' | 'suspended'): Promise<void>
  /** Periodic "still working" signal for surfaces without a native indicator: posts once, then
   * updates the same message (no repeated posts). Cleared when the run finishes or moves. */
  progress?(conversation: Conversation, run: Run, text: string): Promise<void>
  recoverProgress?(): Promise<void>
  delta(conversation: Conversation, run: Run, text: string): Promise<void>
  finish(conversation: Conversation, run: Run, text: string): Promise<void>
  /** The conversation re-anchored: close any in-flight stream where it was. */
  moved?(run: Run): Promise<void>
  flush?(): Promise<void>
}

export interface Rooms {
  create(name: string): Promise<string>
  find(name: string): Promise<string | undefined>
  invite(channel: string, user: string): Promise<void>
  validateUser(user: string): Promise<void>
}
