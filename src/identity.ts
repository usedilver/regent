export type Identity = { name?: string; email?: string }
export type IdentityResolver = (id: string, signal?: AbortSignal) => Promise<Identity>

// Optional enrichment must never hold a run's slot through cancellation or an API stall.
export async function resolveIdentity(resolve: IdentityResolver | undefined, id: string, signal: AbortSignal, timeoutMs = 2000): Promise<Identity> {
  signal.throwIfAborted()
  if (!resolve) return {}
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: () => void = () => {}
  try {
    return await new Promise<Identity>((done, reject) => {
      onAbort = () => { controller.abort(); reject(signal.reason) }
      signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => { controller.abort(); done({}) }, timeoutMs)
      Promise.resolve().then(() => resolve(id, controller.signal)).then(done, () => done({}))
    })
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}
