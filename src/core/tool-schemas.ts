import { GitReadOperations } from './query-git.ts'
import { z } from 'zod'
import { RoomRequest } from './rooms.ts'
import { PreviewRequest } from '../previews/manager.ts'
import { StatusRequest } from './progress.ts'

export const ToolSchemas = {
  regent_read_history: z.object({
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    max_chars: z.number().int().min(1).max(16000).default(12000),
  }),
  regent_git_read: z.object({
    operation: z.enum(GitReadOperations),
    args: z.array(z.string().max(2000)).max(80).default([]),
    directory: z.string().min(1).default('.'),
  }),
  regent_preview: PreviewRequest,
  regent_create_room: RoomRequest,
  regent_use_repo: z.object({
    repo: z.string().min(1),
    handoff: z.string().min(1).max(20000),
    intent: z.enum(['ask', 'patch', 'task', 'project']).optional(),
  }),
  regent_status: StatusRequest,
  regent_ask_human: z.object({
    question: z.string().min(1).max(3000),
    options: z.array(z.string().max(200)).max(5).optional(),
  }),
  regent_cancel: z.object({ reason: z.string().min(1).max(2000) }),
}
