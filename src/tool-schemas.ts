import { z } from 'zod'
import { RoomRequest } from './rooms.ts'
import { PreviewRequest } from './previews.ts'
import { StatusRequest } from './progress.ts'

export const ToolSchemas = {
  regent_preview: PreviewRequest,
  regent_create_room: RoomRequest,
  regent_use_repo: z.object({ repo: z.string().min(1), handoff: z.string().min(1).max(20000), intent: z.enum(['ask', 'patch', 'task', 'project']).optional() }),
  regent_status: StatusRequest,
  regent_ask_human: z.object({ question: z.string().min(1).max(3000), options: z.array(z.string().max(200)).max(5).optional() }),
  regent_cancel: z.object({ reason: z.string().min(1).max(2000) }),
}
