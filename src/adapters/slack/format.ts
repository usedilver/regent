const EMAIL = '[A-Za-z0-9.!#$%&\x27*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+'
/** Markdown links, angle-bracket addresses, bare mailto: links, URLs and bare addresses. */
const LINKS = new RegExp(
  '\\[([^\\]\\n]*)\\]\\(([^\\s)]+)\\)|<(?:mailto:)?(' +
    EMAIL +
    ')>|(?<![A-Za-z0-9_/:])mailto:(' +
    EMAIL +
    ')|https?://[^\\s<>]+|(?<![A-Za-z0-9_@/:.+-])(' +
    EMAIL +
    ')',
  'gi',
)
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const INDENTED_CODE = /^(?: {4}|\t)/
const MARKDOWN_LIMIT = 12000
const PLAIN_PAGE_CHARS = 2800

/** Gives every email address an explicit label; Slack links bare ones without text. */
function linkEmails(prose: string): string {
  return prose.replace(LINKS, (whole, label, target, angle, bare, plain) => {
    if (target) {
      const mailto = /^mailto:/i.test(target) && /^mailto:/i.test(label)
      return mailto ? `[${label.slice(7)}](${target})` : whole
    }

    const address = angle ?? bare ?? plain
    return address ? `[${address}](mailto:${address})` : whole
  })
}

/** Applies `transform` to the prose of one line, leaving inline code spans untouched. */
function outsideInlineCode(line: string, transform: (prose: string) => string): string {
  // Unmatched delimiters are treated as code to the end of the line, conservatively.
  const ticks = /`+/g
  let result = ''
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = ticks.exec(line))) {
    result += transform(line.slice(cursor, match.index))
    const delimiter = match[0]
    let end: RegExpExecArray | null

    do {
      end = ticks.exec(line)
    } while (end && end[0].length !== delimiter.length)

    const stop = end ? end.index + delimiter.length : line.length
    result += line.slice(match.index, stop)
    cursor = stop
    if (!end) break
  }

  return result + transform(line.slice(cursor))
}

function closesFence(line: string, fence: string): boolean {
  const marker = FENCE.exec(line)
  if (!marker) return false
  const sameKind = marker[1][0] === fence[0] && marker[1].length >= fence.length
  return sameKind && !line.slice(marker[0].length).trim()
}

// Normalize only prose. Code examples and existing link destinations stay literal.
export function normalizeEmailLinks(text: string): string {
  let fence: string | undefined

  return text
    .split(/(?<=\n)/)
    .map((line) => {
      if (fence) {
        if (closesFence(line, fence)) fence = undefined
        return line
      }

      const opening = FENCE.exec(line)

      if (opening) {
        fence = opening[1]
        return line
      }

      if (INDENTED_CODE.test(line)) return line
      return outsideInlineCode(line, linkEmails)
    })
    .join('')
}

// Slack's markdown block accepts standard LLM Markdown; top-level text does not.
// Oversized replies use literal sections rather than breaking code fences/links.
export function replyPayloads(text: string) {
  text = normalizeEmailLinks(text)
  if (text.length <= MARKDOWN_LIMIT) return [{ text, blocks: [{ type: 'markdown', text }] }]
  const pages: Array<{ text: string; blocks: any[] }> = []
  let remaining = text

  while (remaining) {
    let end = Math.min(PLAIN_PAGE_CHARS, remaining.length)
    // Never split a surrogate pair across pages.
    if (end < remaining.length && /[\uD800-\uDBFF]/.test(remaining[end - 1])) end--
    const part = remaining.slice(0, end)
    pages.push({
      text: part,
      blocks: [{ type: 'section', text: { type: 'plain_text', text: part, emoji: false } }],
    })
    remaining = remaining.slice(end)
  }

  return pages
}
