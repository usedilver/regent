// Slack's markdown block accepts standard LLM Markdown; top-level text does not.
// Oversized replies use literal sections rather than breaking code fences/links.
export function replyPayloads(text: string) {
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
