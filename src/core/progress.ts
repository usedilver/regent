import { z } from 'zod'
import { failureMessage, type ExecutionFailure } from '../execution/failures.ts'

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
  ) {
    return 'Sigo revisando el codigo y el contexto del proyecto.'
  }

  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    return 'Sigo aplicando los cambios en el proyecto.'
  }

  return 'Sigo trabajando en tu solicitud.'
}

function partialText(message: string, text: string): string {
  const partial = text.trim()
  return `${message}${partial ? `\n\nRespuesta parcial del agente (turno incompleto; no implica tarea completada):\n${partial.slice(-12000)}` : '\nNo se obtuvo una respuesta parcial del agente.'}`
}

export function interruptedText(error: string, text: string): string {
  return partialText(
    `${error || 'Ejecucion detenida.'} La sesion se conserva; escribe continua para retomar.`,
    text,
  )
}

export function failedText(failure: ExecutionFailure, text: string): string {
  const message = failureMessage(failure)
  return ['run_timeout', 'run_stalled', 'execution_failed'].includes(failure.code)
    ? partialText(message, text)
    : message
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
      .describe('Brief progress message for the user.'),
    status: z.string().trim().min(1).max(2000).optional().describe('Alias of text.'),
  })
  .refine((args) => args.text !== undefined || args.status !== undefined, {
    message: 'Use regent_status with { "text": "Progress message" } (status is also accepted).',
  })
