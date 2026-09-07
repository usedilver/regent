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
  intent?: 'ask' | 'patch' | 'task'
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
  intent: 'ask' | 'patch' | 'task'
  state: string
  created_at: number
  result: string | null
  error: string | null
  cost: number
}

export interface Output {
  /** The surface already animates a native "working…" indicator: skip periodic heartbeat notices. */
  animates?: boolean
  question?(conversation: Conversation, question: { id: string; text: string; options: string[] }): Promise<void>
  notice(conversation: Conversation, text: string): Promise<void>
  status(conversation: Conversation, status: 'processing' | 'active' | 'suspended'): Promise<void>
  delta(conversation: Conversation, run: Run, text: string): Promise<void>
  finish(conversation: Conversation, run: Run, text: string): Promise<void>
  gate?(conversation: Conversation, gate: { id: string; kind: string; questions: string[] }, text: string): Promise<void>
  /** The conversation re-anchored (task room): close any in-flight stream where it was. */
  moved?(run: Run): Promise<void>
  /** One-shot human approval request for an exact denied command. */
  approval?(conversation: Conversation, request: { id: string; command: string; cwd: string }): Promise<void>
}
