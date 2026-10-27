export type Intent = 'ask' | 'patch' | 'task' | 'project'

const EXPLICIT = /^\s*\/(ask|patch|task|project)\b\s*/i

// Short approvals and resumes inherit the intent of the previous turn.
const APPROVAL =
  /^(?:si[, .!]*|ok[, .!]*|dale[, .!]*)?(?:implementa(?:lo)?|hazlo|aplica(?:lo)?|procede|adelante|aprobado)[.!\s]*$/
const RESUME = /^(?:si[, .!]*|ok[, .!]*|dale[, .!]*)?(?:continua\w*|retoma\w*|dale|ok|si)[.!\s]*$/

// Scope limits such as "no hagas otros cambios" must not turn a requested edit
// into a query. Explicit read-only requests remain read-only.
const READ_ONLY_ES =
  /\b(?:solo (?:investiga|explica|consulta|lectura)|sin (?:hacer )?cambios|no (?:hagas|realices) (?:ningun )?cambios?|no (?:modifiques|cambies|crees) (?:nada|ningun|ninguna|archivos))\b/
const READ_ONLY_EN = /\b(?:read.only|do not (?:edit|modify|write)|don't (?:edit|modify|write))\b/
const INVESTIGATE_THEN_FIX =
  /^(?:investiga|revisa|analiza)\s+y\s+(?:corrige|arregla|modifica|cambia|actualiza|implementa|aplica|elimina|borra|reemplaza)\b/
const QUESTION =
  /^(?:[¿?]\s*)?(?:como|por que|que\b|cual|cuando|donde|explica\w*|dime|investiga\w*|revisa\w*|analiza\w*|consulta\w*|busca\w*|muestra\w*|how|why|what|which|when|where|explain|review|investigate|analyze|analyse|show|list)\b/
const WANTS_TO_KNOW_ES =
  /^(?:(?:quiero|necesito)\s+(?:que\s+me\s+)?|(?:ayudame|puedes|podrias|me puedes)\s+(?:a\s+)?)(?:saber|entend\w*|consult\w*|investig\w*|analiz\w*|revis\w*|expli(?:c|q)\w*|conoc\w*|compar\w*|ver|veas|busc\w*|digas|decir\w*)\b/
const WANTS_TO_KNOW_EN =
  /^(?:i (?:want|need) to |(?:can|could|would) you )(?:explain|review|investigate|analyze|analyse|understand|know|compare|see|check|read|list|find|search|learn)\b/

const DO_THE_CHANGES =
  /\b(?:haz|realiza)\s+(?:(?:los|estos|esos|el|este|ese|un|una)\s+)?(?:cambios?|arreglos?|refactor)\b/
const BUILD =
  /\b(?:crea\w*|constru\w*|desarrolla\w*|implementa\w*|arma\w*|monta\w*|hagamos|quiero|necesito|build|create|scaffold)\b/
const TRACKER_ITEM =
  /\b(?:crea\w*|actualiza\w*|agrega\w*)\b.*\b(?:tarea|tarjeta|card|ticket|notion|jira)\b/
const EDIT =
  /\b(?:corrige\w*|arregla\w*|soluciona\w*|modifica\w*|cambia\w*|actualiza\w*|agrega\w*|quita\w*|elimina\w*|borra\w*|aplica\w*|refactoriza\w*|reemplaza\w*|change|update|add|remove|delete|replace|refactor|fix|patch|edit)\b/
const PROJECT_NOUN =
  /\b(?:proyecto|app|aplicacion|dashboard|sitio|website|landing|repositorio|project)\b/
const DEPLOY = /\b(?:despliega\w*|publica\w*|deploy|clona\w*|ejecuta\w*)\b/
/** Lowercase, accent-free text without a leading "¿", "¡" or "por favor". */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/^[¿¡]\s*/, '')
    .replace(/^(?:por favor|please)[,:]?\s+/, '')
}

export function routeIntent(text: string, previous?: Intent): { intent: Intent; text: string } {
  const explicit = text.match(EXPLICIT)

  if (explicit) {
    return { intent: explicit[1].toLowerCase() as Intent, text: text.slice(explicit[0].length) }
  }

  const value = normalize(text)

  if (APPROVAL.test(value)) {
    const intent = previous === 'project' || previous === 'patch' ? previous : 'task'
    return { intent, text }
  }

  if (RESUME.test(value)) return { intent: previous ?? 'ask', text }
  if (READ_ONLY_ES.test(value)) return { intent: 'ask', text }
  if (INVESTIGATE_THEN_FIX.test(value)) return { intent: 'patch', text }
  if (READ_ONLY_EN.test(value)) return { intent: 'ask', text }

  const asksAQuestion =
    QUESTION.test(value) || WANTS_TO_KNOW_ES.test(value) || WANTS_TO_KNOW_EN.test(value)

  if (asksAQuestion) return { intent: 'ask', text }
  if (DO_THE_CHANGES.test(value)) return { intent: 'patch', text }
  if (TRACKER_ITEM.test(value)) return { intent: 'task', text }
  if (EDIT.test(value)) return { intent: 'patch', text }

  const builds = BUILD.test(value)
  if (builds && PROJECT_NOUN.test(value)) return { intent: 'project', text }

  if (builds || DEPLOY.test(value)) {
    return { intent: previous === 'project' ? 'project' : 'task', text }
  }

  return { intent: 'ask', text }
}
