/**
 * Markdown → bloques de Notion. Además de lo básico (títulos, listas, código,
 * quote, divider), entiende dos contenedores que el cuerpo de un card necesita:
 *   <details><summary>Título</summary> … </details>  → toggle (plegable) con hijos
 *   > [!NOTE|WARNING|QUESTION|INFO] texto              → callout con ícono
 * Las líneas `> ` consecutivas forman UN quote, no uno por línea. El texto de
 * cada bloque pasa por `inline`: negrita, cursiva, código, tachado y links
 * llegan como anotaciones de rich_text, no como asteriscos literales.
 */
export type Block = Record<string, unknown>
type Annotations = { bold?: boolean; italic?: boolean; strikethrough?: boolean; code?: boolean }
type RichText = { type: 'text'; text: { content: string; link?: { url: string } }; annotations?: Annotations }
export type Rich = RichText[]

const NOTION_TEXT_CHUNK = 2000
const NOTION_MAX_RICH = 100
const NOTION_MAX_CHILDREN = 100
const NOTION_MAX_NESTING = 2

/** Texto plano troceado al límite de Notion (sin anotaciones: bloques de código). */
export function chunkText(str: string): Rich {
  const chunks: string[] = []
  for (let i = 0; i < str.length; i += NOTION_TEXT_CHUNK) chunks.push(str.slice(i, i + NOTION_TEXT_CHUNK))
  if (chunks.length === 0) chunks.push('')
  return chunks.map(c => ({ type: 'text', text: { content: c } }))
}

const INLINE = new RegExp([
  '(?<code>`[^`\\n]+`)',
  '(?<link>\\[[^\\]\\n]+\\]\\(https?:\\/\\/[^\\s)]+\\))',
  '(?<bold>\\*\\*[^\\n]+?\\*\\*|__[^\\n]+?__)',
  '(?<strike>~~[^\\n]+?~~)',
  '(?<italic>(?<![\\w*])\\*(?!\\s)[^*\\n]+?(?<!\\s)\\*(?![\\w*])|(?<![\\w_])_(?!\\s)[^_\\n]+?(?<!\\s)_(?![\\w_]))',
].join('|'))
const LINK_PARTS = /^\[([^\]]+)\]\((\S+)\)$/

/** `**negrita**`, `*cursiva*`/`_cursiva_`, `` `código` ``, `~~tachado~~`, `[texto](url)` → rich_text anotado. */
export function inline(md: string, ann: Annotations = {}, link?: string): Rich {
  const out: Rich = []
  const push = (content: string, a: Annotations, url?: string) => {
    for (const chunk of content ? chunkText(content) : []) {
      const rt: RichText = { type: 'text', text: { content: chunk.text.content, ...(url ? { link: { url } } : {}) } }
      if (Object.keys(a).length) rt.annotations = { ...a }
      out.push(rt)
    }
  }
  let rest = md
  while (rest) {
    const m = rest.match(INLINE)
    if (!m || m.index === undefined) { push(rest, ann, link); break }
    push(rest.slice(0, m.index), ann, link)
    const tok = m[0]
    const kind = Object.entries(m.groups ?? {}).find(([, v]) => v !== undefined)?.[0]

    if (kind === 'code') push(tok.slice(1, -1), { ...ann, code: true }, link)
    if (kind === 'link') { const [, label, url] = tok.match(LINK_PARTS)!; out.push(...inline(label, ann, url)) }
    if (kind === 'bold') out.push(...inline(tok.slice(2, -2), { ...ann, bold: true }, link))
    if (kind === 'strike') out.push(...inline(tok.slice(2, -2), { ...ann, strikethrough: true }, link))
    if (kind === 'italic') out.push(...inline(tok.slice(1, -1), { ...ann, italic: true }, link))
    rest = rest.slice(m.index + tok.length)
  }
  if (out.length === 0) return chunkText('')
  return out.slice(0, NOTION_MAX_RICH)
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
const CALLOUT_COLOR: Record<string, string> = { WARNING: 'yellow_background', QUESTION: 'orange_background' }

export function mdToBlocks(md: string, depth = 0): Block[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: 'paragraph', paragraph: { rich_text: inline(para.join('\n')) } })
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
      const toggle: Block = { type: 'toggle', toggle: { rich_text: inline(m[1]) } }
      if (children.length) (toggle.toggle as Record<string, unknown>).children = children.slice(0, NOTION_MAX_CHILDREN)
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
        rich_text: inline(text.filter(Boolean).join('\n')),
        icon: { type: 'emoji', emoji: CALLOUT_ICON[kind] ?? '💬' },
        color: CALLOUT_COLOR[kind] ?? 'gray_background',
      } })
      continue
    }

    if ((m = line.match(/^>\s?(.*)$/))) {
      flushPara()
      const text = [m[1]]
      i++
      while (i < lines.length && /^>\s?(.*)$/.test(lines[i]) && !/^>\s*\[!/.test(lines[i])) { text.push(lines[i].replace(/^>\s?/, '')); i++ }
      blocks.push({ type: 'quote', quote: { rich_text: inline(text.join('\n')) } })
      continue
    }

    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      flushPara()
      const key = `heading_${m[1].length}`
      blocks.push({ type: key, [key]: { rich_text: inline(m[2]) } })
    } else if ((m = line.match(/^\s*-\s+\[( |x|X)\]\s+(.*)$/))) {
      flushPara()
      blocks.push({ type: 'to_do', to_do: { checked: m[1].toLowerCase() === 'x', rich_text: inline(m[2]) } })
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      flushPara()
      blocks.push({ type: 'bulleted_list_item', bulleted_list_item: { rich_text: inline(m[1]) } })
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara()
      blocks.push({ type: 'numbered_list_item', numbered_list_item: { rich_text: inline(m[1]) } })
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
