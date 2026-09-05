import { Store, redact } from './store.ts'

export class Effects {
  store: Store
  running = new Map<string, Promise<any>>()
  constructor(store: Store) { this.store = store }
  once<T>(key: string, create: () => Promise<T>, reconcile: () => Promise<T | undefined>): Promise<T> {
    if (this.running.has(key)) return this.running.get(key)!
    const work = (async () => {
      const row = this.store.db.prepare('SELECT * FROM effects WHERE key=?').get(key)
      if (row?.state === 'done') return JSON.parse(row.result as string) as T
      if (row) {
        const found = await reconcile()
        if (found === undefined) throw new Error(`Efecto pendiente de reconciliar (${key}); no se repetira una creacion de resultado incierto.`)
        this.store.db.prepare("UPDATE effects SET state='done',result=?,error=NULL WHERE key=?").run(JSON.stringify(found), key)
        return found
      }
      this.store.db.prepare("INSERT INTO effects(key,state) VALUES(?,'pending')").run(key)
      try {
        const result = await create()
        this.store.db.prepare("UPDATE effects SET state='done',result=?,error=NULL WHERE key=?").run(JSON.stringify(result), key)
        return result
      } catch (error) {
        this.store.db.prepare('UPDATE effects SET error=? WHERE key=?').run(redact((error as Error).message), key)
        throw error
      }
    })().finally(() => this.running.delete(key))
    this.running.set(key, work)
    return work
  }
}
