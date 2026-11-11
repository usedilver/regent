import fs from 'node:fs'
import type { Conversation } from './types.ts'
import { isolationFor } from './repository.ts'

/**
 * Where a run starts. A conversation works in the project's shared checkout until its agent
 * enters the conversation's worktree to change code; later runs start there.
 */
export function executionContext(conversation: Conversation) {
  const isolation = fs.existsSync(conversation.cwd + '/.git')
    ? isolationFor(conversation.cwd, conversation.key)
    : undefined
  const isolated = Boolean(isolation && fs.existsSync(isolation.dir + '/.git'))

  if (isolated && fs.realpathSync(isolation!.dir) !== isolation!.dir) {
    throw new Error('The conversation worktree must not be a symbolic link.')
  }

  const directory = isolated ? isolation!.dir : conversation.cwd
  // Older sessions always used a native worktree. Resume only when it still exists.
  const previous = conversation.session_cwd ?? (isolated ? isolation!.dir : null)
  return {
    isolated,
    directory,
    /** The worktree this conversation owns, entered or not; none outside a Git project. */
    worktree: isolation,
    sessionId: conversation.session_id && previous === directory ? conversation.session_id : null,
  }
}
