export type Intent = 'ask' | 'patch' | 'task' | 'project'

export function routeIntent(text: string, previous?: Intent): { intent: Intent; text: string } {
  const explicit = text.match(/^\s*\/(ask|patch|task|project)\b\s*/i)
  if (explicit) return { intent: explicit[1].toLowerCase() as Intent, text: text.slice(explicit[0].length) }
  const value = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
  if (/^(?:si[, .!]*|ok[, .!]*|dale[, .!]*)?(?:continua\w*|retoma\w*|procede|hazlo|adelante|implementa(?:lo)?|aprobado|dale|ok|si)[.!\s]*$/.test(value)) return { intent: previous ?? 'task', text }
  // Explicit questions/negation must not turn quoted examples into execution requests.
  if (/^(?:[¿?]\s*)?(?:como|por que|que\b|cual|cuando|donde|explica\w*|dime|investiga\w*|consulta\w*|busca\w*|muestra\w*)\b/.test(value) || /\b(?:no (?:hagas|modifiques|cambies|crees)|solo (?:investiga|explica|consulta))\b/.test(value)) return { intent: 'ask', text }
  const build = /\b(?:crea\w*|constru\w*|desarrolla\w*|implementa\w*|arma\w*|monta\w*|hagamos|quiero|necesito|build|create|scaffold)\b/.test(value)
  if (/\b(?:crea\w*|actualiza\w*|agrega\w*)\b.*\b(?:tarea|tarjeta|card|ticket|notion|jira)\b/.test(value)) return { intent: 'task', text }
  if (/\b(?:corrige\w*|arregla\w*|soluciona\w*|modifica\w*|cambia\w*|actualiza\w*|agrega\w*|quita\w*|fix|patch|edit)\b/.test(value)) return { intent: 'patch', text }
  if (build && /\b(?:proyecto|app|aplicacion|dashboard|sitio|website|landing|repositorio|project)\b/.test(value)) return { intent: 'project', text }
  if (build || /\b(?:despliega\w*|publica\w*|deploy|clona\w*|ejecuta\w*)\b/.test(value)) return { intent: previous === 'project' ? 'project' : 'task', text }
  return { intent: 'ask', text }
}
