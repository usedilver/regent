import { z } from 'zod'
import type { Active, Core } from './core.ts'
import type { Run } from './types.ts'

const reason = z.string().trim().min(1).max(1500)
const localPath = z
  .string()
  .min(1)
  .max(2000)
  .refine((value) => {
    const base = new URL('https://preview.invalid')
    if (!value.startsWith('/') || !URL.canParse(value, base)) return false
    const target = new URL(value, base)
    return target.origin === base.origin && !target.hash
  }, 'Use a path on the reserved preview host, starting with /.')

export const ReviewAssessment = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('verified'), reason, path: localPath }),
  z.object({ kind: z.literal('required'), reason }),
  z.object({ kind: z.literal('not_applicable'), reason }),
  z.object({ kind: z.literal('blocked'), reason }),
  z.object({
    kind: z.literal('external'),
    reason,
    url: z.url().refine((value) => {
      const url = new URL(value)
      return url.protocol === 'https:' && !url.username && !url.password
    }, 'Use an HTTPS URL without credentials.'),
  }),
])
export type ReviewAssessment = z.infer<typeof ReviewAssessment>

export interface ReviewDelivery {
  state: 'ready' | 'reported' | 'not_applicable' | 'blocked' | 'missing'
  reason: string
  url?: string
  expires_at?: string
  verification?: 'executor'
  http_status?: number
}

export interface PreviewVerification {
  id: string
  pid: number | null
  process_start: string | null
  delivery: ReviewDelivery
}

const PROBE_TIMEOUT_MS = 5000

/** Records an executor's app-level check; the runtime probes transport, not business correctness. */
export async function verifyPreview(core: Core, active: Active): Promise<PreviewVerification> {
  core.store.event(active.run.id, 'preview_verification', null)
  const assessment = active.review
  if (assessment?.kind !== 'verified') throw new Error('Missing executor verification.')
  const manager = core.previews
  const preview = manager?.get(active.run.conversation_key)
  if (!manager || !preview || !manager.result(preview).ready) {
    throw new Error('There is no live, owned preview process to verify.')
  }
  const current = manager.result(preview)
  const url = new URL(assessment.path, current.url).href
  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    headers: { connection: 'close' },
  })
  await response.body?.cancel()
  if (response.status >= 400)
    throw new Error(
      `The requested preview path responds HTTP ${response.status}; verification was not recorded.`,
    )
  const fresh = manager.get(active.run.conversation_key)
  if (
    !fresh ||
    fresh.id !== preview.id ||
    fresh.pid !== preview.pid ||
    fresh.process_start !== preview.process_start ||
    !manager.result(fresh).ready
  ) {
    throw new Error('The preview process changed during verification.')
  }
  const verification: PreviewVerification = {
    id: preview.id,
    pid: preview.pid,
    process_start: preview.process_start,
    delivery: {
      state: 'reported',
      verification: 'executor',
      reason: assessment.reason,
      url,
      expires_at: current.expires_at,
      http_status: response.status,
    },
  }
  core.store.event(active.run.id, 'preview_verification', verification)
  return verification
}

export function verifiedPreview(core: Core, run: Run): ReviewDelivery | undefined {
  const source =
    run.intent === 'ask'
      ? (core.store.db
          .prepare(
            "SELECT id FROM runs WHERE conversation_key=? AND intent!='ask' AND rowid <= (SELECT rowid FROM runs WHERE id=?) ORDER BY rowid DESC LIMIT 1",
          )
          .get(run.conversation_key, run.id)?.id as string | undefined)
      : run.id
  if (!source) return
  const recorded = core.store.lastEvent<PreviewVerification>(source, 'preview_verification')
  const manager = core.previews
  const current = manager?.get(run.conversation_key)
  if (
    !recorded ||
    !manager ||
    !current ||
    recorded.id !== current.id ||
    recorded.pid !== current.pid ||
    recorded.process_start !== current.process_start ||
    !manager.result(current).ready
  )
    return
  return recorded.delivery
}

/** Optional reporting only. Project instructions decide whether any review is needed. */
export function reviewDelivery(core: Core, active: Active): ReviewDelivery | undefined {
  if (
    active.readOnly ||
    active.waiting ||
    active.contextChanged ||
    active.worktreeRemoval !== undefined
  )
    return
  const assessment = active.review
  if (!assessment) return
  if (assessment.kind === 'verified') {
    return (
      verifiedPreview(core, active.run) ?? {
        state: 'blocked',
        reason: 'The verified preview process is no longer available.',
      }
    )
  }
  if (assessment.kind === 'external')
    return { state: 'reported', url: assessment.url, reason: assessment.reason }
  if (assessment.kind === 'not_applicable' || assessment.kind === 'blocked')
    return { state: assessment.kind, reason: assessment.reason }
  return { state: 'missing', reason: assessment.reason }
}
