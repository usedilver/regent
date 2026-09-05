import { mdToBlocks, inline } from './md-blocks.ts'

export async function notionChildren(notion: any, id: string): Promise<any[]> {
  const blocks: any[] = []
  let cursor: string | undefined
  do {
    const response = await notion.blocks.children.list({ block_id: id, page_size: 100, start_cursor: cursor })
    blocks.push(...response.results)
    cursor = response.has_more ? response.next_cursor : undefined
  } while (cursor)
  return blocks
}

export async function replaceChildren(notion: any, id: string, md: string): Promise<void> {
  const desired = mdToBlocks(md)
  for (const block of await notionChildren(notion, id)) await notion.blocks.delete({ block_id: block.id })
  for (let i = 0; i < desired.length; i += 100) await notion.blocks.children.append({ block_id: id, children: desired.slice(i, i + 100) })
}

/** Own only the contents under the named anchor; unrelated card sections survive. */
export async function upsertSection(notion: any, pageId: string, title: string, md: string): Promise<string> {
  const blocks = await notionChildren(notion, pageId)
  const text = (block: any) => (block.heading_2?.rich_text ?? []).map((t: any) => t.plain_text ?? t.text?.content ?? '').join('')
  const matches = blocks.filter(block => block.type === 'heading_2' && text(block) === title)
  if (matches.some(block => !block.heading_2.is_toggleable)) throw new Error(`La seccion ${title} existente no es un ancla administrada por regent; no se sobrescribira.`)
  let anchor = matches[0]
  if (!anchor) {
    const result = await notion.blocks.children.append({ block_id: pageId, children: [
      { object: 'block', type: 'heading_2', heading_2: { rich_text: inline(title), is_toggleable: true } },
    ] })
    anchor = result.results[0]
  }
  await replaceChildren(notion, anchor.id, md)
  for (const duplicate of matches.slice(1)) await notion.blocks.delete({ block_id: duplicate.id })
  return anchor.id
}

export async function upsertPlan(notion: any, pageId: string, md: string): Promise<string> {
  let page = (await notionChildren(notion, pageId)).find(block => block.type === 'child_page' && block.child_page.title === 'Plan tecnico')
  if (!page) page = await notion.pages.create({ parent: { page_id: pageId }, properties: { title: { type: 'title', title: inline('Plan tecnico') } } })
  await replaceChildren(notion, page.id, md)
  return page.id
}
