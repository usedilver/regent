export interface ExecutionFailure {
  source: 'claude' | 'regent' | 'slack'
  code:
    | 'usage_limit'
    | 'context_window'
    | 'rate_limit'
    | 'authentication'
    | 'run_budget'
    | 'history_unavailable'
    | 'compaction_failed'
  detail: string
  reset?: string
  fresh_session?: boolean
}

export class HistoryUnavailable extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'HistoryUnavailable'
  }
}

const contextOverflow =
  /prompt[_ -](?:is[_ -])?too[_ -]long|conversation too long|context[_ -]length[_ -]exceeded|context[_ -]window(?:[_ -]exceeded| (?:is )?(?:full|exceeded))|context[_ -]limit[_ -](?:reached|exceeded)|maximum context length/i

export function executionFailure(detail: string): ExecutionFailure | undefined {
  // A failed compaction can wrap the real blocker: quota, authentication or rate limiting.
  if (
    /you['’]ve hit your (?:session|weekly|usage) limit|usage limit (?:reached|exceeded)|out of (?:extra )?usage|credit balance is too low/i.test(
      detail,
    )
  ) {
    const reset = detail.match(/\bresets?\s+([^\n]{1,150})/i)?.[1]
    return { source: 'claude', code: 'usage_limit', detail, ...(reset ? { reset } : {}) }
  }
  if (
    /rate[_ -]limit(?:_error| exceeded| reached)?|too many requests|(?:HTTP|API)(?:[ _-]error)?\s*:?\s*429\b|status(?:Code|_code)?[\"'\s]*[:=]\s*429\b/i.test(
      detail,
    )
  )
    return { source: 'claude', code: 'rate_limit', detail }
  if (
    /authentication_error|invalid (?:api key|authentication)|not logged in|please (?:log|sign) in|OAuth token (?:has )?expired|(?:HTTP|API)(?:[ _-]error)?\s*:?\s*401\b|status(?:Code|_code)?[\"'\s]*[:=]\s*401\b/i.test(
      detail,
    )
  )
    return { source: 'claude', code: 'authentication', detail }
  if (
    /error_max_budget_usd|presupuesto diario agotado|(?:maximum|max) budget (?:exceeded|reached)|budget (?:limit )?exceeded/i.test(
      detail,
    )
  )
    return { source: 'regent', code: 'run_budget', detail }
  const compaction = detail.match(/automatic compaction failed:\s*([^\n]+)/i)?.[1]
  if (compaction && !contextOverflow.test(compaction))
    return { source: 'claude', code: 'compaction_failed', detail }
  if (contextOverflow.test(detail)) return { source: 'claude', code: 'context_window', detail }
}

export function failureMessage(failure: ExecutionFailure): string {
  switch (failure.code) {
    case 'usage_limit':
      return `La cuenta de Claude agotó su cuota de uso.${failure.reset ? ` Claude indica que se restablece: ${failure.reset}.` : ''} El trabajo se conserva; podrás continuar cuando vuelva a haber cuota. Reiniciar la conversación no recupera esa cuota.`
    case 'context_window':
      if (failure.fresh_session)
        return 'El contexto inicial supera la ventana de contexto de Claude, incluso con una sesión nueva. El código y el hilo se conservan; el operador debe revisar las instrucciones, herramientas y adjuntos antes de reintentar.'
      return 'La sesión de Claude superó su ventana de contexto. El código y el hilo se conservan; envía «continúa» para retomar con una sesión de ejecución nueva.'
    case 'rate_limit':
      return 'Claude alcanzó un límite temporal de peticiones. El trabajo se conserva; espera un momento antes de continuar.'
    case 'authentication':
      return 'Claude no pudo autenticar la ejecución. El operador debe revisar el acceso del CLI; el trabajo se conserva.'
    case 'run_budget':
      return 'Se alcanzó el presupuesto de ejecución configurado en Regent. El trabajo se conserva; el operador puede revisar ese presupuesto.'
    case 'compaction_failed':
      return 'Claude no pudo compactar su contexto para continuar. El trabajo se conserva; el operador debe revisar el fallo de compactación antes de reintentarlo.'
    case 'history_unavailable':
      return `Regent no pudo recuperar el historial de Slack. No es un límite de contexto de Claude. Detalle: ${failure.detail.slice(0, 500)}`
  }
}
