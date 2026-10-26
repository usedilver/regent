/** Bare words a user can send to control the conversation instead of asking for work. */
const STOP = ['stop', 'para'] as const
const RESET = ['reset', 'nuevo'] as const

export type ControlCommand = (typeof STOP)[number] | (typeof RESET)[number]

export const CONTROL_COMMANDS: readonly ControlCommand[] = [...STOP, ...RESET]

export function controlCommand(text: string): ControlCommand | null {
  const word = text.trim().toLowerCase()
  return (CONTROL_COMMANDS as readonly string[]).includes(word) ? (word as ControlCommand) : null
}

export function isStopCommand(command: ControlCommand): boolean {
  return (STOP as readonly string[]).includes(command)
}
