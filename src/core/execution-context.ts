import fs from 'node:fs'
import type { Conversation } from './types.ts'
import type { Intent } from './intent.ts'
import { isolationFor } from './repository.ts'

export function executionContext(conversation: Conversation, intent: Intent) {
  const readOnly = intent === 'ask'
  const isolation = fs.existsSync(conversation.cwd + '/.git')
    ? isolationFor(conversation.cwd, conversation.key)
    : undefined
  const existing = isolation && fs.existsSync(isolation.dir + '/.git')
  if (existing && fs.realpathSync(isolation.dir) !== isolation.dir)
    throw new Error('The conversation worktree must not be a symbolic link.')
  const isolated = Boolean(isolation && (!readOnly || existing))
  const directory = isolated ? isolation!.dir : conversation.cwd
  // Older sessions always used a native worktree. Resume only when it still exists.
  const previous = conversation.session_cwd ?? (existing ? isolation!.dir : null)
  return {
    readOnly,
    isolated,
    directory,
    worktreeName: isolated ? isolation!.name : undefined,
    sessionId: conversation.session_id && previous === directory ? conversation.session_id : null,
  }
}
