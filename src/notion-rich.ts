/** rich_text de Notion → mrkdwn de Slack, para espejar comentarios sin perder el formato. */
export interface NotionRichText {
  plain_text?: string
  href?: string | null
  annotations?: { bold?: boolean; italic?: boolean; strikethrough?: boolean; code?: boolean }
}

const escapeMrkdwn = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function richToMrkdwn(parts: NotionRichText[]): string {
  return parts.map(p => {
    const raw = p.plain_text ?? ''
    if (!raw.trim()) return raw
    const a = p.annotations ?? {}
    if (a.code) return `\`${raw}\``
    // los marcadores de Slack no pueden envolver espacios: se aplican al texto sin bordes
    const lead = raw.match(/^\s*/)![0]
    const trail = raw.match(/\s*$/)![0]
    let core = escapeMrkdwn(raw.slice(lead.length, raw.length - trail.length))
    if (p.href) core = `<${p.href}|${core}>`
    if (a.bold) core = `*${core}*`
    if (a.italic) core = `_${core}_`
    if (a.strikethrough) core = `~${core}~`
    return lead + core + trail
  }).join('')
}
