// Normalize only prose. Code examples and existing link destinations stay literal.
export function normalizeEmailLinks(text: string): string {
  const email = '[A-Za-z0-9.!#$%&\x27*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+'
  const links = new RegExp('\\[([^\\]\\n]*)\\]\\(([^\\s)]+)\\)|<(?:mailto:)?(' + email + ')>|(?<![A-Za-z0-9_/:])mailto:(' + email + ')|https?://[^\\s<>]+|(?<![A-Za-z0-9_@/:.+-])(' + email + ')', 'gi')
  const prose = (part: string) => part.replace(links, (whole, label, target, angle, bare, plain) => {
    if (target) return /^mailto:/i.test(target) && /^mailto:/i.test(label) ? `[${label.slice(7)}](${target})` : whole
    const address = angle ?? bare ?? plain
    if (!address) return whole
    // Slack converts bare emails to links without a text label; explicitly supply one.
    return `[${address}](mailto:${address})`
  })
  let fence: string | undefined
  return text.split(/(?<=\n)/).map(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !line.slice(marker[0].length).trim()) fence = undefined
      return line
    }
    if (marker) { fence = marker[1]; return line }
    if (/^(?: {4}|\t)/.test(line)) return line
    // Preserve inline code, including unmatched delimiters, conservatively.
    let result = '', cursor = 0
    const ticks = /`+/g
    let match: RegExpExecArray | null
    while ((match = ticks.exec(line))) {
      result += prose(line.slice(cursor, match.index))
      const delimiter = match[0]
      let end: RegExpExecArray | null
      do { end = ticks.exec(line) } while (end && end[0].length !== delimiter.length)
      const stop = end ? end.index + delimiter.length : line.length
      result += line.slice(match.index, stop); cursor = stop
      if (!end) break
    }
    return result + prose(line.slice(cursor))
  }).join('')
}

// Slack's markdown block accepts standard LLM Markdown; top-level text does not.
// Oversized replies use literal sections rather than breaking code fences/links.
export function replyPayloads(text: string) {
  text = normalizeEmailLinks(text)
  if (text.length <= 12000) return [{ text, blocks: [{ type: 'markdown', text }] }]
  const pages: Array<{ text: string; blocks: any[] }> = []
  let remaining = text
  while (remaining) {
    let end = Math.min(2800, remaining.length)
    if (end < remaining.length && /[\uD800-\uDBFF]/.test(remaining[end - 1])) end--
    const part = remaining.slice(0, end)
    pages.push({ text: part, blocks: [{ type: 'section', text: { type: 'plain_text', text: part, emoji: false } }] })
    remaining = remaining.slice(end)
  }
  return pages
}
