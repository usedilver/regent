import { Client } from '@notionhq/client'
import { inline } from '../md-blocks.ts'
import { notionChildren, upsertPlan, upsertSection } from '../notion-sections.ts'
import type { Config } from './config.ts'

export interface BoardFields { repo?: string; pr?: string; size?: string; owner?: string }
export interface Tracker {
  create(key: string, title: string): Promise<{ id: string; url: string }>
  find(key: string, title: string): Promise<{ id: string; url: string } | undefined>
  section(id: string, section: string, md: string): Promise<void>
  properties?(id: string, fields: BoardFields): Promise<{ skipped: string[] }>
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
    return { title, status, properties: schema.properties as Record<string, any> }
  }
  /** Set typed board columns; skip (never silently fail) what the board lacks or what cannot be mapped. */
  async properties(id: string, fields: BoardFields): Promise<{ skipped: string[] }> {
    const { properties } = await this.schema()
    const names = this.config.notion.properties
    const update: Record<string, any> = {}
    const skipped: string[] = []
    const url = (name: string | null | undefined, value: string | undefined, label: string) => {
      if (value === undefined) return
      const prop = name ? properties[name] : undefined
      if (!prop) skipped.push(`${label}: el board no tiene la propiedad ${name}`)
      else if (prop.type !== 'url') skipped.push(`${label}: ${name} no es de tipo url`)
      else update[name] = { url: value }
    }
    url(names.repo, fields.repo, 'repo')
    url(names.pr, fields.pr, 'pr')
    if (fields.size !== undefined && names.estimation) {
      const prop = properties[names.estimation]
      const option = this.config.notion.estimation_values[fields.size]
      if (!prop) skipped.push(`estimation: el board no tiene la propiedad ${names.estimation}`)
      else if (!['select', 'status'].includes(prop.type)) skipped.push(`estimation: ${names.estimation} no es select`)
      else if (!option) skipped.push(`estimation: falta notion.estimation_values.${fields.size}`)
      else if (!(prop[prop.type]?.options ?? []).some((o: any) => o.name === option)) skipped.push(`estimation: la opcion ${option} no existe en ${names.estimation}`)
      else update[names.estimation] = { [prop.type]: { name: option } }
    }
    if (fields.owner !== undefined && names.owner) {
      const prop = properties[names.owner]
      const person = this.config.notion.people[fields.owner]
      if (!prop) skipped.push(`owner: el board no tiene la propiedad ${names.owner}`)
      else if (prop.type !== 'people') skipped.push(`owner: ${names.owner} no es de tipo people`)
      else if (!person) skipped.push(`owner: sin mapeo Notion para ${fields.owner} en notion.people`)
      else update[names.owner] = { people: [{ object: 'user', id: person }] }
    }
    if (Object.keys(update).length) await this.client.pages.update({ page_id: id, properties: update })
    return { skipped }
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
