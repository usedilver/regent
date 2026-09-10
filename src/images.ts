export interface ImageReference { id: string; name: string }
export interface ImageInput { label: string; mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }
export type ImageLoader = (reference: ImageReference, signal: AbortSignal) => Promise<Omit<ImageInput, 'label'>>
export const IMAGE_LIMIT = 5
export const IMAGE_BYTES = 3 * 1024 * 1024
export const TURN_IMAGE_BYTES = 10 * 1024 * 1024

export async function prepareImages(pending: { messageId: string; reference: ImageReference; label: string }[], loader: ImageLoader | undefined, signal: AbortSignal) {
  const images: ImageInput[] = [], warnings: string[] = [], skipped = new Set<string>()
  const loaded = new Map<string, Awaited<ReturnType<ImageLoader>>>()
  let bytes = 0, attempts = 0
  for (const item of pending) {
    signal.throwIfAborted()
    try {
      const previous = loaded.get(item.reference.id)
      if (previous) continue
      if (attempts++ >= IMAGE_LIMIT) throw new Error(`limite de ${IMAGE_LIMIT} imagenes por turno; envia un hilo mas acotado`)
      if (!loader) throw new Error('lector de imagenes no disponible')
      const image = await loader(item.reference, signal)
      signal.throwIfAborted()
      const size = Buffer.byteLength(image.data, 'base64')
      if (size > IMAGE_BYTES || bytes + size > TURN_IMAGE_BYTES) throw new Error('limite de bytes de imagenes excedido')
      bytes += size
      loaded.set(item.reference.id, image)
      images.push({ ...image, label: item.label })
    } catch (error) {
      signal.throwIfAborted()
      skipped.add(item.messageId)
      if (warnings.length < IMAGE_LIMIT) warnings.push(`${item.label}: no se pudo adjuntar la imagen (${(error as Error).message}). No infieras su contenido; si hace falta, pide reenviarla o transcribirla.`)
    }
  }
  if (skipped.size > warnings.length) warnings.push(`Otras ${skipped.size - warnings.length} imagenes quedaron sin adjuntar. Pide un hilo mas acotado; no infieras su contenido.`)
  return { images, warnings, skipped }
}
