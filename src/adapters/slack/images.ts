import { imageSize } from 'image-size'
import {
  IMAGE_BYTES,
  type ImageInput,
  type ImageLoader,
  type ImageReference,
} from '../../core/images.ts'
import type { SlackApi } from './api.ts'
import { downloadUrl, FILE_ID, fileInfo, openDownload } from './files.ts'

const IMAGE_TYPES = /^(png|jpe?g|gif|webp|heic|heif|svg|avif)$/i
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|heic|heif|svg|avif)$/i
const DOWNLOAD_TIMEOUT_MS = 10000
const MAX_DIMENSION = 8000
const MEDIA_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
} as const

export function imageReference(file: any): ImageReference | undefined {
  if (typeof file?.id !== 'string' || !FILE_ID.test(file.id)) return
  const looksLikeImage =
    /^image\//i.test(file.mimetype ?? '') ||
    IMAGE_TYPES.test(file.filetype ?? '') ||
    IMAGE_EXTENSIONS.test(file.name ?? '') ||
    file.file_access === 'check_file_info'

  if (!looksLikeImage) return

  return {
    id: file.id,
    name: String(file.title ?? file.name ?? file.id)
      .replace(/[\r\n]/g, ' ')
      .slice(0, 200),
  }
}

async function downloadBytes(
  url: URL,
  token: string,
  download: typeof fetch,
  timeout: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of await openDownload(url, token, download, timeout)) {
    timeout.throwIfAborted()
    size += chunk.length
    if (size > IMAGE_BYTES) throw new Error('imagen mayor a 3 MiB')
    chunks.push(Buffer.from(chunk))
  }

  return Buffer.concat(chunks)
}

/** Validates the bytes as an image the model accepts and returns them base64-encoded. */
function decodeImage(buffer: Buffer): Omit<ImageInput, 'label'> {
  let dimensions: ReturnType<typeof imageSize>

  try {
    dimensions = imageSize(buffer)
  } catch {
    throw new Error('imagen invalida o formato no compatible')
  }

  const mediaType = MEDIA_TYPES[dimensions.type as keyof typeof MEDIA_TYPES]
  if (!mediaType) throw new Error('formato no compatible; usa PNG, JPEG, GIF o WebP')
  const { width, height } = dimensions

  if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error('dimensiones no compatibles; maximo 8000 x 8000')
  }

  return { mediaType, data: buffer.toString('base64') }
}

export function slackImageLoader(
  api: SlackApi,
  token: string,
  download: typeof fetch = fetch,
): ImageLoader {
  return async (reference, signal) => {
    if (!FILE_ID.test(reference.id)) throw new Error('ID de archivo invalido')
    // URLs are refreshed from Slack, never accepted from message text or stored snapshots.
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)])
    const file = await fileInfo(api, reference.id, timeout)
    timeout.throwIfAborted()

    if (!file || file.id !== reference.id || file.is_external) {
      throw new Error('archivo no disponible en Slack')
    }

    if (file.size > IMAGE_BYTES) throw new Error('imagen mayor a 3 MiB')
    return decodeImage(await downloadBytes(downloadUrl(file), token, download, timeout))
  }
}
