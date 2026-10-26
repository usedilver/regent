import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { parseEnvFile } from '../env.ts'
import type { Active, Core } from './core.ts'
import { isInside } from './repository.ts'

const reason = z.string().trim().min(1).max(1500)
export const ReviewAssessment = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('required'), reason }),
  z.object({ kind: z.literal('not_applicable'), reason }),
  z.object({ kind: z.literal('blocked'), reason }),
  z.object({
    kind: z.literal('external'),
    reason,
    url: z.url().refine((value) => {
      const url = new URL(value)
      return url.protocol === 'https:' && !url.username && !url.password
    }, 'Use an HTTPS preview URL without credentials.'),
  }),
])
export type ReviewAssessment = z.infer<typeof ReviewAssessment>

export interface ReviewDelivery {
  state: 'ready' | 'reported' | 'not_applicable' | 'blocked' | 'missing'
  reason: string
  url?: string
  expires_at?: string
}

const MAX_REVIEW_RETRIES = 2
const PUBLIC_PREVIEW_TIMEOUT_MS = 5000

export async function reviewDelivery(
  core: Core,
  active: Active,
): Promise<ReviewDelivery | undefined> {
  if (active.readOnly || !core.previews || active.waiting || active.contextChanged) return
  const assessment = active.review
  if (!assessment) return { state: 'missing', reason: 'Falta evaluar la revision visual.' }
  if (assessment.kind === 'not_applicable') {
    return { state: 'not_applicable', reason: assessment.reason }
  }
  if (assessment.kind === 'external') {
    return { state: 'reported', url: assessment.url, reason: assessment.reason }
  }

  const preview = core.previews.get(active.run.conversation_key)
  const current = preview ? core.previews.result(preview) : undefined
  if (current?.ready && active.previewPublished) {
    try {
      const response = await fetch(current.url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(PUBLIC_PREVIEW_TIMEOUT_MS),
        headers: { connection: 'close' },
      })
      await response.body?.cancel()
      if (response.status < 500) {
        return {
          state: 'ready',
          url: current.url,
          expires_at: current.expires_at,
          reason:
            'Preview publicado en este turno y accesible por HTTPS; conserva el login de la app.',
        }
      }
    } catch {
      // Publication ownership and public HTTPS reachability are separate checks.
    }
    return { state: 'blocked', reason: 'El preview publicado no responde por su URL publica.' }
  }

  if (assessment.kind === 'blocked' && active.previewAttempted) {
    return { state: 'blocked', reason: assessment.reason }
  }
  return { state: 'missing', reason: 'No se publico y verifico un preview de este turno.' }
}

export function setupSummary(active: Active): Array<{
  file: string
  present: boolean
  keys?: number
  nonempty_keys?: number
}> {
  if (!active.executionDir) return []
  const root = active.executionDir
  const summaries = []
  for (const relative of ['.', ...(active.workspace?.submodules ?? [])]) {
    const directory = path.resolve(root, relative)
    if (!isInside(root, directory)) continue
    const include = path.join(directory, '.worktreeinclude')
    if (!fs.existsSync(include)) continue
    for (const entry of fs.readFileSync(include, 'utf8').split('\n')) {
      const file = entry.trim()
      if (!file || file.startsWith('#') || !path.basename(file).startsWith('.env')) continue
      const destination = path.resolve(directory, file)
      if (!isInside(root, destination)) continue
      const label = path.relative(root, destination)
      if (!fs.existsSync(destination)) {
        summaries.push({ file: label, present: false })
        continue
      }
      if (!isInside(root, fs.realpathSync(destination))) continue
      const values = Object.values(parseEnvFile(destination))
      summaries.push({
        file: label,
        present: true,
        keys: values.length,
        nonempty_keys: values.filter((value) => value.trim()).length,
      })
    }
  }
  return summaries.slice(0, 32)
}

export async function completionCheck(core: Core, active: Active) {
  if (active.cancelled || core.stopping || active.abort.signal.aborted || active.resumeAfterWait) {
    return { decision: 'allow' as const }
  }
  const delivery = await reviewDelivery(core, active)
  if (delivery) core.store.event(active.run.id, 'review_check', { state: delivery.state })
  if (!delivery || ['ready', 'reported', 'not_applicable'].includes(delivery.state)) {
    return { decision: 'allow' as const }
  }
  if (delivery.state === 'blocked' && active.previewAttempted) {
    return { decision: 'allow' as const }
  }
  const closing = active.wrapUpAt !== undefined && Date.now() >= active.wrapUpAt
  if (closing || (active.reviewRetries ?? 0) >= MAX_REVIEW_RETRIES) {
    return { decision: 'allow' as const }
  }
  active.reviewRetries = (active.reviewRetries ?? 0) + 1
  core.store.event(active.run.id, 'review_retry', { attempt: active.reviewRetries })
  return {
    decision: 'block' as const,
    reason:
      'La entrega visual no esta resuelta. Evalua el cambio real con regent_status usando text: "Validando la entrega", review: {kind: "required" | "not_applicable" | "blocked", reason: "..."}. Eliminar una pantalla o un enlace tambien requiere revisar la navegacion restante. Para un cambio visible publica un preview con regent_preview reserve, inicia la app y llama publish; un preview existente debe confirmarse con publish en este turno. No repitas cambios, commits ni PRs. Si hay un bloqueo real, intenta iniciar y publicar el preview y declara blocked con su evidencia; reservar un puerto no demuestra un bloqueo. No inventes un enlace. Un preview externo ya verificado se declara con kind: "external", url y reason. No deduzcas que el entorno esta vacio de una lista que oculta valores. Archivos de setup, solo conteos: ' +
      JSON.stringify(setupSummary(active)),
  }
}

export function reviewText(delivery: ReviewDelivery | undefined, text: string): string {
  if (!delivery || delivery.state === 'not_applicable') return text
  if (delivery.url) {
    if (text.includes(delivery.url)) return text
    return `Preview para revisar:\n${delivery.url}\n\n${text}`
  }
  return `Revision visual pendiente: no se entrego un preview navegable. ${delivery.reason}\n\nInforme del agente (no confirma la revision visual):\n${text}`
}
