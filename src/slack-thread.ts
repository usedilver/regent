/**
 * Texto útil de un mensaje de Slack, venga de donde venga: `text`, adjuntos
 * legacy (`attachments`: título/texto/campos — así publican Sentry, Laravel
 * Log y la mayoría de los webhooks) y bloques (`blocks`: section/rich_text).
 * Sin esto, el mensaje que TRAE el error llega vacío al intake.
 */
export interface SlackAttachment { title?: string; pretext?: string; text?: string; fallback?: string; fields?: Array<{ title?: string; value?: string }> }
export interface SlackBlock { type?: string; text?: { text?: string }; fields?: Array<{ text?: string }>; elements?: unknown[] }
export interface SlackMsgLike {
  text?: string
  bot_id?: string
  username?: string
  bot_profile?: { name?: string }
  attachments?: SlackAttachment[]
  blocks?: SlackBlock[]
}

function richText(elements: unknown[] | undefined, out: string[]): void {
  for (const el of elements ?? []) {
    const e = el as { type?: string; text?: string; elements?: unknown[] }
    if (typeof e.text === 'string') out.push(e.text)
    if (e.elements) richText(e.elements, out)
  }
}

/** Las apps pegan las vallas inline ("Context: ```{…}```"); markdown las necesita en línea propia. */
export function normalizeFences(text: string): string {
  return text
    .replace(/([^\n])```(\w*)\n/g, '$1\n```$2\n')
    .replace(/^```(\w*)([^\n`])/gm, '```$1\n$2')
    .replace(/([^\n`])```(?=\s*$)/gm, '$1\n```')
}

export function attachmentText(a: SlackAttachment): string {
  const parts: string[] = []
  if (a.pretext) parts.push(a.pretext)
  if (a.title) parts.push(a.title)
  if (a.text) parts.push(a.text)
  else if (a.fallback) parts.push(a.fallback)
  for (const f of a.fields ?? []) {
    if (!f.value) continue
    const v = normalizeFences(f.value)
    parts.push(f.title ? (v.includes('\n') ? `${f.title}:\n${v}` : `${f.title}: ${v}`) : v)
  }
  return parts.join('\n')
}

export function blocksText(blocks: SlackBlock[] | undefined): string {
  const out: string[] = []
  for (const b of blocks ?? []) {
    if (b.text?.text) out.push(b.text.text)
    for (const f of b.fields ?? []) if (f.text) out.push(f.text)
    if (b.type === 'rich_text') richText(b.elements, out)
  }
  return out.join('\n')
}

/** Cuerpo completo del mensaje (sin archivos: esos se leen aparte). */
export function messageBody(m: SlackMsgLike): string {
  const parts = [m.text ?? '', ...(m.attachments ?? []).map(attachmentText), blocksText(m.blocks)]
  return parts.map(p => p.trim()).filter(Boolean).join('\n')
}

/** Cómo firmar un mensaje de app en el transcript. */
export const appLabel = (m: SlackMsgLike): string => `[app ${m.bot_profile?.name ?? m.username ?? 'bot'}]`

/**
 * Transcript del hilo → markdown para el card: plegado en un toggle, autor en
 * negrita, y las vallas ``` de los adjuntos intactas (el trace queda como código,
 * no como veinte quotes). Fuera de una valla nada se toca.
 */
export function threadToMarkdown(transcript: string, title = 'Hilo de origen (Slack)'): string {
  const out: string[] = []
  let inFence = false
  for (const line of transcript.split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; out.push(line); continue }
    if (inFence) { out.push(line); continue }
    const m = line.match(/^(@[^:]+|\[app [^\]]+\]):\s?(.*)$/)
    out.push(m ? `**${m[1]}:** ${m[2]}` : line)
  }
  return `<details><summary>${title}</summary>\n${out.join('\n')}\n</details>`
}
