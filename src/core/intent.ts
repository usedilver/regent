export type Intent = 'ask' | 'patch' | 'task' | 'project'

// These prefixes are protocol commands, not natural-language intent detection.
const EXPLICIT = /^\s*\/(ask|patch|task|project)(?=\s|$)\s*/i

export function requestProfile(text: string): { intent: Intent; text: string } {
  const explicit = text.match(EXPLICIT)
  if (!explicit) return { intent: 'task', text }
  return { intent: explicit[1].toLowerCase() as Intent, text: text.slice(explicit[0].length) }
}
