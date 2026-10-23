import type { Core } from '../core/core.ts'
import { Previews } from './manager.ts'
import { createPreviewHttp } from './http.ts'
import { httpLifecycle } from '../adapters/http-lifecycle.ts'

export async function startPreviewServer(core: Core) {
  if (!core.config.previews) return
  const previews = new Previews(core.store, core.config.previews)
  const http = httpLifecycle(createPreviewHttp(previews))
  try {
    await http.listen(core.config.previews.listen_port)
    previews.start()
    core.previews = previews
  } catch (error) {
    previews.close()
    await http.close()
    throw error
  }
  return async () => {
    previews.close()
    core.previews = undefined
    await http.close()
  }
}
