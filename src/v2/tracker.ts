import { Client } from '@notionhq/client'
import { inline } from '../md-blocks.ts'
import { notionChildren, upsertPlan, upsertSection } from '../notion-sections.ts'
import type { Config } from './config.ts'

export interface Tracker {
  create(key: string, title: string): Promise<{ id: string; url: string }>
  find(key: string, title: string): Promise<{ id: string; url: string } | undefined>
  section(id: string, section: string, md: string): Promise<void>
  done(id: string): Promise<void>
}
export class NotionTracker implements Tracker {
  client: any; config: Config; source: string
  constructor(config: Config, client = new Client({ auth: process.env.NOTION_TOKEN, timeoutMs: 15000 }), source = process.env.DATA_SOURCE_ID ?? '') {
    this.config = config; this.client = client; this.source = source
  }
  async schema() {
    if (!this.source) throw new Error('Configura DATA_SOURCE_ID y NOTION_TOKEN para crear tareas.')
    const schema = await this.client.dataSources.retrieve({ data_source_id: this.source })
    const title = Object.entries(schema.properties).find(([, p]: any) => p.type === 'title')?.[0]
    if (!title) throw new Error('No encontre la propiedad de titulo del board.')
    const status = schema.properties[this.config.notion.properties.status]
    if (!status || !['status', 'select'].includes(status.type)) throw new Error('La propiedad de estado del board no coincide con regent.yaml.')
    return { title, status }
  }
  async create(key: string, title: string) {
    const schema = await this.schema()
    const page = await this.client.pages.create({ parent: { type: 'data_source_id', data_source_id: this.source },
      properties: { [schema.title]: { title: inline(title) }, [this.config.notion.properties.status]: { [schema.status.type]: { name: this.config.notion.landing_status } } },
      children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: inline(`Regent reference: ${key}`) } }],
    })
    return { id: page.id, url: page.url }
  }
  async find(key: string, title: string) {
    const schema = await this.schema()
    let cursor: string | undefined
    do {
      const response = await this.client.dataSources.query({ data_source_id: this.source, filter: { property: schema.title, title: { equals: title } }, start_cursor: cursor })
      for (const page of response.results) {
        const blocks = await notionChildren(this.client, page.id)
        if (blocks.some(b => (b.paragraph?.rich_text ?? []).map((t: any) => t.plain_text ?? t.text?.content ?? '').join('') === `Regent reference: ${key}`)) return { id: page.id, url: page.url }
      }
      cursor = response.has_more ? response.next_cursor : undefined
    } while (cursor)
    return undefined
  }
  async section(id: string, section: string, md: string) {
    if (section === 'plan') { await upsertPlan(this.client, id, md); return }
    const names: Record<string, string> = { summary: 'Que se va a hacer', implementation: 'Implementacion', qa: 'QA', digest: 'Resumen de la conversacion' }
    if (!names[section]) throw new Error('Seccion desconocida.')
    await upsertSection(this.client, id, names[section], md)
  }
  async done(id: string) {
    const schema = await this.schema()
    await this.client.pages.update({ page_id: id, properties: { [this.config.notion.properties.status]: { [schema.status.type]: { name: this.config.notion.pr_merged_moves_to } } } })
  }
}
