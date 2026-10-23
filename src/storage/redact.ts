const sensitiveKey = (key: string) =>
  /(?:^|_)(?:password|passwd|pgpassword|pwd|passphrase|secret|token|api_key|private_key|authorization|cookie|credentials?)(?:_|$)/i.test(
    key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-.]/g, '_'),
  )

export function redact(text: string): string {
  return text
    .replace(
      /\b(?:sk-ant-|sk-|xox[baprs]-|xapp-|gh[pousr]_|github_pat_|ntn_)[A-Za-z0-9_-]+/g,
      '[REDACTED]',
    )
    .replace(/(Bearer\s+)[^\s"\\]+/gi, '$1[REDACTED]')
    .replace(
      /((?:password|api[_-]?key|secret|access[_-]?token)\s*["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
      '$1[REDACTED]',
    )
}

// Redact string values in place, never the serialized JSON: redacting the envelope can
// corrupt structure (an escaped quote inside a matched value) and make JSON.parse fail forever.
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') {
    if (/^\s*[\[{]/.test(value)) {
      try {
        return JSON.stringify(redactDeep(JSON.parse(value))) as T
      } catch {
        /* Non-JSON text still passes through textual redaction. */
      }
    }
    return redact(value) as T
  }
  if (Array.isArray(value)) return value.map(redactDeep) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value))
      out[k] = sensitiveKey(k) && v != null ? '[REDACTED]' : redactDeep(v)
    return out as T
  }
  return value
}
