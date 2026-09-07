import { randomUUID } from 'node:crypto'
import type { Config } from './config.ts'
import type { Conversation, Output } from './types.ts'
import { Store, redact } from './store.ts'
import { Changes, hash, type Worktree } from './changes.ts'
import { Effects } from './effects.ts'
import { ownerRepoOf } from '../workspace.ts'
import type { BoardFields, Tracker } from './tracker.ts'
import { hasOpenQuestions } from '../router.ts'

export interface Rooms {
  create(name: string, author: string, text: string): Promise<{ channel: string; thread: string }>
  find(name: string): Promise<{ channel: string; thread: string } | undefined>
  history(channel: string): Promise<string>
  archive(channel: string): Promise<void>
}
export interface Task {
  id: string; conversation_key: string; title: string; size: string; impact: string; state: string
  notion_id: string | null; url: string | null; room: string | null; room_thread: string | null
}
export interface Gate { id: string; task_id: string; kind: string; revision: string; state: string; conversation: string; questions: string; actor: string | null; dispatched: number }

export class Tasks {
  store: Store; config: Config; changes: Changes; tracker: Tracker; output: Output; effects: Effects; rooms?: Rooms
  locks = new Map<string, Promise<any>>()
  adapter?: string
  constructor(store: Store, config: Config, changes: Changes, tracker: Tracker, output: Output, rooms?: Rooms) {
    this.store = store; this.config = config; this.changes = changes; this.tracker = tracker; this.output = output; this.rooms = rooms; this.effects = new Effects(store)
  }
  exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(operation).finally(() => { if (this.locks.get(key) === current) this.locks.delete(key) })
    this.locks.set(key, current)
    return current
  }
  get(id: string): Task {
    const task = this.store.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as unknown as Task | undefined
    if (!task) throw new Error('Tarea inexistente.')
    return task
  }
  of(key: string): Task | undefined {
    const id = this.store.conversation(key)?.task_id
    if (!id) return
    const row = this.store.db.prepare('SELECT * FROM tasks WHERE id=?').get(id)
    if (!row) throw new Error('Esta conversacion pertenece a una tarea v1; termina la migracion del card antes de modificarla con v2.')
    return row as unknown as Task
  }
  canWrite(key: string): boolean {
    const task = this.of(key)
    const traceCard = task?.id === hash(`small:${key}`).slice(0, 32)
    return !task || ['implementing', 'awaiting_qa'].includes(task.state) || (traceCard && task.state === 'awaiting_merge')
  }
  destination(task: Task, fallback?: Conversation): Conversation {
    const c = fallback ?? this.store.conversation(task.conversation_key)!
    return task.room ? { ...c, channel: task.room, thread: task.room_thread } : c
  }
  async create(c: Conversation, args: { title: string; summary_md: string; size: string; impact: string; plan_md?: string }) {
    return this.exclusive(c.key, async () => {
      const id = hash(`${c.key}\n${args.title.trim().toLowerCase()}`).slice(0, 32)
      const existing = this.of(c.key)
      if (existing && existing.id !== id) throw new Error('Esta conversacion ya tiene una tarea; usa otra conversacion para una tarea distinta.')
      if (existing && existing.state !== 'planning') return existing
      this.store.transaction(() => {
        this.store.db.prepare('INSERT OR IGNORE INTO tasks(id,conversation_key,title,size,impact,created_at) VALUES(?,?,?,?,?,?)').run(id, c.key, args.title, args.size, args.impact, Date.now())
        this.store.db.prepare('UPDATE conversations SET task_id=? WHERE key=?').run(id, c.key)
      })
      const page = await this.effects.once(`task:${id}`, () => this.tracker.create(id, args.title), () => this.tracker.find(id, args.title))
      this.store.db.prepare('UPDATE tasks SET notion_id=?,url=? WHERE id=?').run(page.id, page.url, id)
      await this.writeSection(this.get(id), 'summary', args.summary_md)
      if (args.plan_md) await this.writeSection(this.get(id), 'plan', args.plan_md)
      await this.setProperties(this.get(id), { size: args.size, owner: c.author })
      if (this.config.policy.room !== 'never' && this.rooms && c.adapter === 'slack') {
        const name = `task-${id.slice(0, 20)}`
        const room = await this.effects.once(`room:${id}`, () => this.rooms!.create(name, c.author, `${args.title}\n${page.url}`), () => this.rooms!.find(name))
        this.store.db.prepare('UPDATE tasks SET room=?,room_thread=? WHERE id=?').run(room.channel, room.thread, id)
      }
      return this.get(id)
    })
  }
  async writeSection(task: Task, section: string, md: string) {
    if (!task.notion_id) throw new Error('La creacion de la tarea sigue pendiente.')
    const revision = hash(md)
    const previous = this.store.db.prepare('SELECT * FROM sections WHERE task_id=? AND section=?').get(task.id, section)
    if (previous?.state === 'done' && previous.revision === revision) return
    this.store.db.prepare("INSERT INTO sections(task_id,section,md,revision) VALUES(?,?,?,?) ON CONFLICT(task_id,section) DO UPDATE SET md=excluded.md,revision=excluded.revision,state='pending'").run(task.id, section, redact(md), revision)
    await this.tracker.section(task.notion_id, section, redact(md))
    this.store.db.prepare("UPDATE sections SET state='done' WHERE task_id=? AND section=? AND revision=?").run(task.id, section, revision)
  }
  /** Best-effort board columns: metadata never blocks the flow, and skips are logged, not silenced. */
  async setProperties(task: Task, fields: BoardFields) {
    if (!task.notion_id || !this.tracker.properties) return
    try {
      const { skipped } = await this.tracker.properties(task.notion_id, fields)
      if (skipped.length) console.error(`[v2 board] ${task.id}: ${skipped.join('; ')}`)
    } catch (error) { console.error(`[v2 board] ${task.id}: ${redact((error as Error).message)}`) }
  }
  async update(c: Conversation, args: { task_id: string; section: string; md: string; questions?: string[] }) {
    return this.exclusive(c.key, async () => {
      const task = this.get(args.task_id)
      if (task.conversation_key !== c.key) throw new Error('No puedes escribir una tarea de otra conversacion.')
      if (['completed', 'cancelled', 'awaiting_merge'].includes(task.state)) throw new Error('La tarea no admite cambios en este estado.')
      if (args.section === 'plan' && this.changes.list(c.key).some(w => this.changes.locks.has(w.id))) throw new Error('Espera a que terminen las operaciones del worktree antes de cambiar el plan.')
      if (args.section === 'plan') {
        this.store.db.prepare("UPDATE tasks SET state='planning' WHERE id=?").run(task.id)
        this.store.db.prepare("UPDATE task_gates SET state='superseded' WHERE task_id=? AND state='pending'").run(task.id)
      }
      await this.writeSection(task, args.section, args.md)
      if (args.section !== 'plan') return { updated: true }
      const questions = args.questions?.length ? args.questions : hasOpenQuestions(args.md) || /[?\u00bf]/.test(args.md) ? ['Responde las preguntas abiertas del plan antes de aprobar.'] : []
      if (this.config.policy.fast_track && task.size === 'S' && task.impact === 'low' && !questions.length) {
        this.store.db.prepare("UPDATE tasks SET state='implementing' WHERE id=?").run(task.id)
        await this.output.notice(this.destination(task, c), 'Plan habilitado por la via rapida: esfuerzo S, impacto bajo y sin preguntas. QA sigue requiriendo revision humana.')
        return { fast_track: true }
      }
      return this.planGate(task, this.destination(task, c), hash(args.md), questions)
    })
  }
  async planGate(task: Task, c: Conversation, revision: string, questions: string[]) {
    return this.gate(task, c, 'plan', revision, questions, 'Revisa el plan tecnico antes de implementar.')
  }
  async gate(task: Task, c: Conversation, kind: string, revision: string, questions: string[], text: string) {
    const old = this.store.db.prepare("SELECT * FROM task_gates WHERE task_id=? AND kind=? AND revision=? AND state='pending'").get(task.id, kind, revision) as unknown as Gate | undefined
    const id = old?.id ?? randomUUID()
    if (!old) {
      this.store.db.prepare("UPDATE task_gates SET state='superseded' WHERE task_id=? AND kind=? AND state='pending'").run(task.id, kind)
      this.store.db.prepare('INSERT INTO task_gates(id,task_id,kind,revision,conversation,questions) VALUES(?,?,?,?,?,?)').run(id, task.id, kind, revision, JSON.stringify(c), JSON.stringify(questions))
    }
    this.store.db.prepare('UPDATE tasks SET state=? WHERE id=?').run(kind === 'plan' ? 'awaiting_plan' : 'awaiting_qa', task.id)
    if (this.output.gate) await this.output.gate(c, { id, kind, questions }, text)
    else await this.output.notice(c, `${text}\n${questions.join('\n')}\nCompuerta: ${id}`)
    return { waiting_human: true, gate_id: id, questions }
  }
  decide(id: string, decision: string, author: string, channel?: string) {
    const gate = this.store.db.prepare('SELECT * FROM task_gates WHERE id=?').get(id) as unknown as Gate | undefined
    if (!gate) throw new Error('Compuerta inexistente.')
    const c = JSON.parse(gate.conversation) as Conversation
    if (channel && channel !== c.channel) throw new Error('La compuerta pertenece a otra conversacion.')
    if (!['approve', 'changes', 'cancel'].includes(decision)) throw new Error('Decision invalida.')
    if (gate.state !== 'pending') {
      if (gate.dispatched || gate.state !== decision || gate.actor !== author) return { duplicate: true, conversation: c }
      return this.decisionResult(gate, c, decision)
    }
    if (decision === 'approve' && JSON.parse(gate.questions).length) throw new Error('El plan tiene preguntas abiertas; pide una revision antes de aprobar.')
    const task = this.get(gate.task_id)
    if (this.locks.has(c.key)) throw new Error('Espera a que termine la actualizacion de la tarea antes de decidir.')
    if (decision === 'approve' && gate.kind === 'qa' && this.changes.list(c.key).some(w => this.changes.locks.has(w.id))) throw new Error('Espera a que termine la publicacion antes de aprobar QA.')
    if (decision === 'approve' && gate.kind === 'qa' && gate.revision !== this.prRevision(c.key)) throw new Error('El PR cambio desde esta revision; usa la compuerta nueva.')
    this.store.transaction(() => {
      this.store.db.prepare('UPDATE task_gates SET state=?,actor=?,decided_at=? WHERE id=?').run(decision, author, Date.now(), id)
      this.store.db.prepare('UPDATE tasks SET state=? WHERE id=?').run(decision === 'cancel' ? 'cancelled' : gate.kind === 'plan' ? decision === 'approve' ? 'implementing' : 'planning' : decision === 'approve' ? 'awaiting_merge' : 'implementing', task.id)
    })
    return this.decisionResult(gate, c, decision)
  }
  decisionResult(gate: Gate, c: Conversation, decision: string) {
    return { duplicate: false, conversation: c, resume: decision !== 'cancel' && !(gate.kind === 'qa' && decision === 'approve'),
      text: decision === 'changes' ? gate.kind === 'plan' ? 'El humano pidio cambios al plan. Pregunta que debe corregirse; no implementes aun.' : 'El humano reporto una falla de QA. Pide el detalle y corrige el mismo PR.' : 'El humano aprobo esta version del plan. Implementa en worktrees y publica los PRs.', decision }
  }
  prRevision(key: string): string {
    return hash(JSON.stringify(this.store.db.prepare('SELECT p.url,p.head FROM prs p JOIN worktrees w ON w.id=p.worktree_id WHERE w.conversation_key=? ORDER BY p.url').all(key)))
  }
  async openPr(c: Conversation, args: { repo: string; title: string; body_md: string }, signal?: AbortSignal) {
    return this.exclusive(c.key, async () => {
      const task = this.of(c.key)
      if (task && !this.canWrite(c.key)) throw new Error('Falta la aprobacion humana del plan o la tarea ya esta cerrada.')
      const result = await this.changes.publish(c.key, args, Boolean(task && task.size !== 'S'), signal)
      if ('refused' in result) return result
      await this.output.notice(c, `PR: ${result.url}`)
      const boardRepo = ownerRepoOf(this.changes.get(c.key, args.repo).origin)
      const board: BoardFields = { repo: boardRepo ? `https://github.com/${boardRepo}` : undefined, pr: result.url }
      const roomAlways = this.config.policy.room === 'always' && Boolean(this.rooms) && c.adapter === 'slack'
      if (task) {
        const prs = this.store.db.prepare('SELECT p.url FROM prs p JOIN worktrees w ON w.id=p.worktree_id WHERE w.conversation_key=? ORDER BY p.url').all(c.key)
        await this.writeSection(task, 'implementation', prs.map(p => `- ${p.url}`).join('\n'))
        await this.setProperties(task, board)
      } else {
        // room: always attaches every unit of work to a room, which needs a card to anchor to.
        if (this.config.policy.track_small_fixes === 'digest' && this.config.slack.digest_channel && !roomAlways) {
          await this.effects.once(`fix-digest:${result.url}`, async () => { await this.output.notice({ ...c, channel: this.config.slack.digest_channel!, thread: null }, `${args.title}: ${result.url}`); return true }, async () => undefined)
        }
        if (this.config.policy.track_small_fixes === 'card' || roomAlways) {
          const id = hash(`small:${c.key}`).slice(0, 32)
          this.store.db.prepare("INSERT OR IGNORE INTO tasks(id,conversation_key,title,size,impact,state,created_at) VALUES(?,?,?,'S','low','awaiting_merge',?)").run(id, c.key, args.title, Date.now())
          const page = await this.effects.once(`task:${id}`, () => this.tracker.create(id, args.title), () => this.tracker.find(id, args.title))
          this.store.db.prepare('UPDATE tasks SET notion_id=?,url=? WHERE id=?').run(page.id, page.url, id)
          this.store.db.prepare('UPDATE conversations SET task_id=? WHERE key=?').run(id, c.key)
          await this.writeSection(this.get(id), 'implementation', `${args.body_md}\n\n${result.url}`)
          await this.setProperties(this.get(id), { ...board, size: 'S', owner: c.author })
        }
      }
      // The card may already be linked after an interrupted room creation.
      const linked = this.of(c.key)
      if (roomAlways && linked && !linked.room) {
        const name = `task-${linked.id.slice(0, 20)}`
        const room = await this.effects.once(`room:${linked.id}`, () => this.rooms!.create(name, c.author, `${linked.title}\n${linked.url}`), () => this.rooms!.find(name))
        this.store.db.prepare('UPDATE tasks SET room=?,room_thread=? WHERE id=?').run(room.channel, room.thread, linked.id)
        await this.output.notice(this.destination(this.get(linked.id), c), `PR: ${result.url}`)
      }
      return result
    })
  }
  async requestQa(c: Conversation) {
    return this.exclusive(c.key, async () => {
      const task = this.of(c.key)
      if (!task || !this.canWrite(c.key)) throw new Error('La tarea no esta lista para QA.')
      const worktrees = this.changes.list(c.key)
      if (!worktrees.length || worktrees.some(w => !this.store.db.prepare('SELECT 1 FROM prs WHERE worktree_id=?').get(w.id))) throw new Error('Publica un PR por cada worktree antes de solicitar QA.')
      return this.gate(task, this.destination(task, c), 'qa', this.prRevision(c.key), [], 'Prueba todos los PRs de esta tarea.')
    })
  }
  async poll() {
    const keys = this.store.db.prepare("SELECT DISTINCT w.conversation_key FROM worktrees w JOIN prs p ON w.id=p.worktree_id JOIN conversations c ON c.key=w.conversation_key WHERE w.state='active' AND (? IS NULL OR c.adapter=?)").all(this.adapter ?? null, this.adapter ?? null)
    for (const row of keys) {
      const key = row.conversation_key as string
      if (this.store.conversation(key)?.state === 'running' || this.locks.has(key)) continue
      await this.exclusive(key, async () => {
        const task = this.of(key)
        if (task && !['awaiting_merge', 'completed'].includes(task.state)) return
        const worktrees = this.changes.list(key)
        const prs = this.store.db.prepare('SELECT p.* FROM prs p JOIN worktrees w ON w.id=p.worktree_id WHERE w.conversation_key=?').all(key)
        for (const w of worktrees) {
          const pr = prs.find(p => p.worktree_id === w.id)
          if (!pr) return
          if (pr.state !== 'MERGED' && !await this.changes.merged(w, pr.url as string)) return
          this.store.db.prepare("UPDATE prs SET state='MERGED' WHERE worktree_id=?").run(w.id)
        }
        const c = task ? this.destination(task) : this.store.conversation(key)!
        if (task && task.notion_id) {
          if (task.room && this.rooms) await this.writeSection(task, 'digest', await this.rooms.history(task.room))
          await this.tracker.done(task.notion_id)
        }
        const completedText = 'Todos los PRs fueron integrados. Tarea completada.'
        await this.effects.once(`merged:${key}`, async () => { await this.output.notice(c, completedText); return true }, async () => {
          const delivered = this.store.db.prepare("SELECT args FROM deliveries WHERE conversation_key=? AND kind='notice'").all(key)
          return delivered.some(row => JSON.parse(row.args as string)[1] === completedText) ? true : undefined
        })
        if (task?.room && this.rooms) await this.rooms.archive(task.room)
        if (task) this.store.db.prepare("UPDATE tasks SET state='completed' WHERE id=?").run(task.id)
        for (const w of worktrees) await this.changes.clean(w)
      }).catch(async error => {
        const message = redact((error as Error).message)
        console.error(`[v2 merge] ${message}`)
        const c = this.store.conversation(key)!
        await this.effects.once(`merge-error:${key}:${hash(message)}`, async () => {
          await this.output.notice(c, `No pude completar el seguimiento del merge: ${message}`); return true
        }, async () => undefined).catch(() => {})
      })
    }
  }
}
