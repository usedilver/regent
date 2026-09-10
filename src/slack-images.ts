import { imageSize } from 'image-size'
import { IMAGE_BYTES, type ImageLoader, type ImageReference } from './images.ts'

export function imageReference(file: any): ImageReference | undefined {
  if (typeof file?.id !== 'string' || !/^F[A-Z0-9]+$/.test(file.id)) return
  if (!/^image\//i.test(file.mimetype ?? '') && !/^(png|jpe?g|gif|webp|heic|heif|svg|avif)$/i.test(file.filetype ?? '') && !/\.(png|jpe?g|gif|webp|heic|heif|svg|avif)$/i.test(file.name ?? '') && file.file_access !== 'check_file_info') return
  return { id: file.id, name: String(file.title ?? file.name ?? file.id).replace(/[\r\n]/g, ' ').slice(0, 200) }
}

export function slackImageLoader(api: (method: string, args: Record<string, any>) => Promise<any>, token: string, download: typeof fetch = fetch): ImageLoader {
  return async (reference, signal) => {
    if (!/^F[A-Z0-9]+$/.test(reference.id)) throw new Error('ID de archivo invalido')
    // URLs are refreshed from Slack, never accepted from message text or stored snapshots.
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(10000)])
    let aborted: () => void = () => {}
    let file: any
    try {
      timeout.throwIfAborted()
      const result: any = await Promise.race([
        api('files.info', { file: reference.id }).catch(() => { throw new Error('Slack no permitio consultar el archivo; revisa files:read y acceso a la conversacion') }),
        new Promise((_, reject) => { aborted = () => reject(new Error('tiempo de descarga agotado')); timeout.addEventListener('abort', aborted, { once: true }) }),
      ])
      file = result.file
    } finally { timeout.removeEventListener('abort', aborted) }
    timeout.throwIfAborted()
    if (!file || file.id !== reference.id || file.is_external) throw new Error('archivo no disponible en Slack')
    if (file.size > IMAGE_BYTES) throw new Error('imagen mayor a 3 MiB')
    let url: URL
    try { url = new URL(file.url_private_download ?? file.url_private) } catch { throw new Error('sin URL de descarga') }
    if (url.protocol !== 'https:' || url.hostname !== 'files.slack.com' || url.port || url.username || url.password) throw new Error('origen de descarga no autorizado')
    const response = await download(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: timeout })
      .catch(() => { timeout.throwIfAborted(); throw new Error('fallo de descarga o redireccion no permitida') })
    if (!response.ok || !response.body) throw new Error(`Slack devolvio HTTP ${response.status}`)
    const chunks: Buffer[] = []; let size = 0
    for await (const chunk of response.body) {
      timeout.throwIfAborted()
      size += chunk.length
      if (size > IMAGE_BYTES) throw new Error('imagen mayor a 3 MiB')
      chunks.push(Buffer.from(chunk))
    }
    const buffer = Buffer.concat(chunks)
    let dimensions: ReturnType<typeof imageSize>
    try { dimensions = imageSize(buffer) } catch { throw new Error('imagen invalida o formato no compatible') }
    const types = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as const
    const mediaType = types[dimensions.type as keyof typeof types]
    if (!mediaType) throw new Error('formato no compatible; usa PNG, JPEG, GIF o WebP')
    if (!dimensions.width || !dimensions.height || dimensions.width > 8000 || dimensions.height > 8000) throw new Error('dimensiones no compatibles; maximo 8000 x 8000')
    return { mediaType, data: buffer.toString('base64') }
  }
}
