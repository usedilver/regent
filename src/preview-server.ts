import type { Core } from './core.ts'
import { Previews } from './previews.ts'
import { createPreviewHttp } from './preview-http.ts'

export async function startPreviewServer(core: Core) {
  if (!core.config.previews) return
  const previews = new Previews(core.store, core.config.previews)
  const server = createPreviewHttp(previews)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(core.config.previews!.listen_port, '127.0.0.1', resolve)
  })
  previews.start()
  core.previews = previews
  return async () => {
    previews.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
