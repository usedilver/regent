export type Intent = 'ask' | 'patch' | 'task' | 'project'

export function routeIntent(text: string, previous?: Intent): { intent: Intent; text: string } {
  const explicit = text.match(/^\s*\/(ask|patch|task|project)\b\s*/i)
  if (explicit)
    return { intent: explicit[1].toLowerCase() as Intent, text: text.slice(explicit[0].length) }
  const value = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/^[¿¡]\s*/, '')
    .replace(/^(?:por favor|please)[,:]?\s+/, '')
  if (
    /^(?:si[, .!]*|ok[, .!]*|dale[, .!]*)?(?:implementa(?:lo)?|hazlo|aplica(?:lo)?|procede|adelante|aprobado)[.!\s]*$/.test(
      value,
    )
  )
    return {
      intent: previous === 'project' ? 'project' : previous === 'patch' ? 'patch' : 'task',
      text,
    }
  if (
    /^(?:si[, .!]*|ok[, .!]*|dale[, .!]*)?(?:continua\w*|retoma\w*|dale|ok|si)[.!\s]*$/.test(value)
  )
    return { intent: previous ?? 'ask', text }
  // Scope limits such as "no hagas otros cambios" must not turn a requested edit
  // into a query. Explicit read-only requests remain read-only.
  if (
    /\b(?:solo (?:investiga|explica|consulta|lectura)|sin (?:hacer )?cambios|no (?:hagas|realices) (?:ningun )?cambios?|no (?:modifiques|cambies|crees) (?:nada|ningun|ninguna|archivos))\b/.test(
      value,
    )
  )
    return { intent: 'ask', text }
  if (
    /^(?:investiga|revisa|analiza)\s+y\s+(?:corrige|arregla|modifica|cambia|actualiza|implementa|aplica|elimina|borra|reemplaza)\b/.test(
      value,
    )
  )
    return { intent: 'patch', text }
  if (
    /^(?:[¿?]\s*)?(?:como|por que|que\b|cual|cuando|donde|explica\w*|dime|investiga\w*|revisa\w*|analiza\w*|consulta\w*|busca\w*|muestra\w*|how|why|what|which|when|where|explain|review|investigate|analyze|analyse|show|list)\b/.test(
      value,
    ) ||
    /^(?:(?:quiero|necesito)\s+(?:que\s+me\s+)?|(?:ayudame|puedes|podrias|me puedes)\s+(?:a\s+)?)(?:saber|entend\w*|consult\w*|investig\w*|analiz\w*|revis\w*|expli(?:c|q)\w*|conoc\w*|compar\w*|ver|veas|busc\w*|digas|decir\w*)\b/.test(
      value,
    ) ||
    /^(?:i (?:want|need) to |(?:can|could|would) you )(?:explain|review|investigate|analyze|analyse|understand|know|compare|see|check|read|list|find|search|learn)\b/.test(
      value,
    ) ||
    /\b(?:read.only|do not (?:edit|modify|write)|don't (?:edit|modify|write))\b/.test(value)
  )
    return { intent: 'ask', text }
  if (
    /\b(?:haz|realiza)\s+(?:(?:los|estos|esos|el|este|ese|un|una)\s+)?(?:cambios?|arreglos?|refactor)\b/.test(
      value,
    )
  )
    return { intent: 'patch', text }
  const build =
    /\b(?:crea\w*|constru\w*|desarrolla\w*|implementa\w*|arma\w*|monta\w*|hagamos|quiero|necesito|build|create|scaffold)\b/.test(
      value,
    )
  if (
    /\b(?:crea\w*|actualiza\w*|agrega\w*)\b.*\b(?:tarea|tarjeta|card|ticket|notion|jira)\b/.test(
      value,
    )
  )
    return { intent: 'task', text }
  if (
    /\b(?:corrige\w*|arregla\w*|soluciona\w*|modifica\w*|cambia\w*|actualiza\w*|agrega\w*|quita\w*|elimina\w*|borra\w*|aplica\w*|refactoriza\w*|reemplaza\w*|change|update|add|remove|delete|replace|refactor|fix|patch|edit)\b/.test(
      value,
    )
  )
    return { intent: 'patch', text }
  if (
    build &&
    /\b(?:proyecto|app|aplicacion|dashboard|sitio|website|landing|repositorio|project)\b/.test(
      value,
    )
  )
    return { intent: 'project', text }
  if (build || /\b(?:despliega\w*|publica\w*|deploy|clona\w*|ejecuta\w*)\b/.test(value))
    return { intent: previous === 'project' ? 'project' : 'task', text }
  return { intent: 'ask', text }
}
