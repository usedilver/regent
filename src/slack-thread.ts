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

export function attachmentText(a: SlackAttachment): string {
  const parts: string[] = []
  if (a.pretext) parts.push(a.pretext)
  if (a.title) parts.push(a.title)
  if (a.text) parts.push(a.text)
  else if (a.fallback) parts.push(a.fallback)
  for (const f of a.fields ?? []) {
    if (!f.value) continue
    parts.push(f.title ? `${f.title}: ${f.value}` : f.value)
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
