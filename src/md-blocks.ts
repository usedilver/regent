/**
 * Markdown → bloques de Notion. Además de lo básico (títulos, listas, código,
 * quote, divider), entiende dos contenedores que el cuerpo de un card necesita:
 *   <details><summary>Título</summary> … </details>  → toggle (plegable) con hijos
 *   > [!NOTE|WARNING|QUESTION|INFO] texto              → callout con ícono
 * Las líneas `> ` consecutivas forman UN quote, no uno por línea.
 */
export type Block = Record<string, unknown>
type Rich = Array<{ type: 'text'; text: { content: string } }>

export function chunkText(str: string): Rich {
  const chunks: string[] = []
  for (let i = 0; i < str.length; i += 2000) chunks.push(str.slice(i, i + 2000))
  if (chunks.length === 0) chunks.push('')
  return chunks.map(c => ({ type: 'text', text: { content: c } }))
}

const CODE_LANGS = new Set(['bash', 'c', 'c++', 'c#', 'css', 'go', 'html', 'java', 'javascript',
  'json', 'kotlin', 'markdown', 'php', 'plain text', 'python', 'ruby', 'rust', 'shell', 'sql',
  'swift', 'typescript', 'yaml'])
export function normalizeLang(lang?: string): string {
  const l = (lang || '').toLowerCase()
  const aliases: Record<string, string> = { js: 'javascript', ts: 'typescript', sh: 'shell', zsh: 'shell', py: 'python', yml: 'yaml', md: 'markdown', cpp: 'c++', cs: 'c#', txt: 'plain text', log: 'plain text' }
  const norm = aliases[l] ?? l
  return CODE_LANGS.has(norm) ? norm : 'plain text'
}

const CALLOUT_ICON: Record<string, string> = { NOTE: '💡', INFO: 'ℹ️', WARNING: '⚠️', QUESTION: '❓', TIP: '💡', IMPORTANT: '📌' }
const NOTION_MAX_NESTING = 2

export function mdToBlocks(md: string, depth = 0): Block[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: 'paragraph', paragraph: { rich_text: chunkText(para.join('\n')) } })
      para = []
    }
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    let m: RegExpMatchArray | null

    if ((m = line.match(/^```(\S*)\s*$/))) {
      flushPara()
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++ }
      i++
      blocks.push({ type: 'code', code: { language: normalizeLang(m[1]), rich_text: chunkText(buf.join('\n')) } })
      continue
    }

    if ((m = line.match(/^<details>\s*<summary>(.*?)<\/summary>\s*$/))) {
      flushPara()
      const inner: string[] = []
      let open = 1
      i++
      while (i < lines.length) {
        if (/^<details>/.test(lines[i])) open++
        if (/^<\/details>\s*$/.test(lines[i])) { open--; if (open === 0) break }
        inner.push(lines[i]); i++
      }
      i++
      const children = depth < NOTION_MAX_NESTING ? mdToBlocks(inner.join('\n'), depth + 1) : []
      const toggle: Block = { type: 'toggle', toggle: { rich_text: chunkText(m[1]) } }
      if (children.length) (toggle.toggle as Record<string, unknown>).children = children.slice(0, 100)
      blocks.push(toggle)
      continue
    }

    if ((m = line.match(/^>\s*\[!(\w+)\]\s*(.*)$/))) {
      flushPara()
      const kind = m[1].toUpperCase()
      const text = [m[2]]
      i++
      while (i < lines.length && /^>\s?(.*)$/.test(lines[i]) && !/^>\s*\[!/.test(lines[i])) { text.push(lines[i].replace(/^>\s?/, '')); i++ }
      blocks.push({ type: 'callout', callout: {
        rich_text: chunkText(text.filter(Boolean).join('\n')),
        icon: { type: 'emoji', emoji: CALLOUT_ICON[kind] ?? '💬' },
        color: kind === 'WARNING' ? 'yellow_background' : kind === 'QUESTION' ? 'orange_background' : 'gray_background',
      } })
      continue
    }

    if ((m = line.match(/^>\s?(.*)$/))) {
      flushPara()
      const text = [m[1]]
      i++
      while (i < lines.length && /^>\s?(.*)$/.test(lines[i]) && !/^>\s*\[!/.test(lines[i])) { text.push(lines[i].replace(/^>\s?/, '')); i++ }
      blocks.push({ type: 'quote', quote: { rich_text: chunkText(text.join('\n')) } })
      continue
    }

    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      flushPara()
      const key = `heading_${m[1].length}`
      blocks.push({ type: key, [key]: { rich_text: chunkText(m[2]) } })
    } else if ((m = line.match(/^\s*-\s+\[( |x|X)\]\s+(.*)$/))) {
      flushPara()
      blocks.push({ type: 'to_do', to_do: { checked: m[1].toLowerCase() === 'x', rich_text: chunkText(m[2]) } })
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      flushPara()
      blocks.push({ type: 'bulleted_list_item', bulleted_list_item: { rich_text: chunkText(m[1]) } })
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara()
      blocks.push({ type: 'numbered_list_item', numbered_list_item: { rich_text: chunkText(m[1]) } })
    } else if (/^\s*---+\s*$/.test(line)) {
      flushPara()
      blocks.push({ type: 'divider', divider: {} })
    } else if (line.trim() === '') {
      flushPara()
    } else {
      para.push(line)
    }
    i++
  }
  flushPara()
  return blocks
}
