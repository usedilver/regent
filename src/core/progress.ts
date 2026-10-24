import { z } from 'zod'

export function progressText(tool: string): string {
  if (
    [
      'Read',
      'Glob',
      'Grep',
      'Skill',
      'mcp__regent__regent_git_read',
      'mcp__regent__regent_read_history',
    ].includes(tool)
  )
    return 'Sigo revisando el codigo y el contexto del proyecto.'
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool))
    return 'Sigo aplicando los cambios en el proyecto.'
  return 'Sigo trabajando en tu solicitud.'
}

export function interruptedText(error: string, text: string): string {
  const partial = text.trim()
  return `${error || 'Ejecucion detenida.'} La sesion se conserva; escribe continua para retomar.${partial ? `\n\nRespuesta parcial del agente (turno interrumpido; no implica tarea completada):\n${partial.slice(-12000)}` : '\nNo se obtuvo una respuesta parcial del agente.'}`
}
export const DevelopmentPhase = z.enum(['investigation', 'implementation', 'validation'])
export type DevelopmentPhase = z.infer<typeof DevelopmentPhase>

export const StatusRequest = z
  .object({
    phase: DevelopmentPhase.optional().describe(
      'Development phase being started; not proof of completion.',
    ),
    text: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .optional()
      .describe('Mensaje breve de progreso para el usuario.'),
    status: z.string().trim().min(1).max(2000).optional().describe('Alias de text.'),
  })
  .refine((args) => args.text !== undefined || args.status !== undefined, {
    message: 'Usa regent_status con { "text": "Mensaje de progreso" } (status tambien es valido).',
  })
