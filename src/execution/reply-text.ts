export class ReplyText {
  private readonly parts: { text: string; messageId?: string }[] = []
  private pending = ''
  private messageId?: string

  observe(raw: any): void {
    if (raw.parent_tool_use_id || raw.isReplay) return

    if (raw.type === 'stream_event') {
      const event = raw.event
      if (event?.type === 'message_start' || event?.type === 'content_block_start') {
        this.flushPending()
      }
      if (event?.type === 'message_start') this.messageId = event.message?.id
      if (event?.type === 'content_block_start' && event.content_block?.type === 'text') {
        this.pending = event.content_block.text ?? ''
      }
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        this.pending += event.delta.text
      }
      return
    }

    if (raw.type === 'result' || raw.type === 'user') {
      this.flushPending()
      return
    }

    if (raw.type !== 'assistant') return
    const texts: string[] = (raw.message?.content ?? [])
      .filter((block: any) => block.type === 'text' && typeof block.text === 'string')
      .map((block: any) => block.text)
    if (!texts.length) return

    // A completed message repeats the text already received as partial deltas.
    if (this.pending && texts.some((text) => text.includes(this.pending))) this.pending = ''
    else this.flushPending()

    for (const text of texts) this.append(text, raw.message?.id ?? raw.uuid)
  }

  text(finalText = ''): string {
    this.flushPending()
    const response = this.parts.map((part) => part.text).join('\n\n')
    const final = finalText.trim()
    if (!final || response.trimEnd().endsWith(final)) return response
    return response ? `${response}\n\n${finalText}` : finalText
  }

  private flushPending(): void {
    if (this.pending) this.append(this.pending, this.messageId)
    this.pending = ''
  }

  private append(text: string, messageId?: string): void {
    if (this.parts.at(-1)?.text === text) return
    if (
      messageId &&
      this.parts.some((part) => part.messageId === messageId && part.text === text)
    ) {
      return
    }
    this.parts.push({ text, messageId })
  }
}
