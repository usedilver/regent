import { parse } from 'shell-quote'

// Parse only literal argv. Expansion and shell control flow remain unsupported.
export function literalCommand(command) {
  if (typeof command !== 'string' || command.length > 8192 || !/^[a-zA-Z0-9_./:@%+=, *?'"\-]+$/.test(command)) return null
  try {
    const words = parse(command, {})
    return words.length && words.every(word => typeof word === 'string') ? words : null
  } catch { return null }
}
