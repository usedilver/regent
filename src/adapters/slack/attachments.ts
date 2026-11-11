import type { AttachmentLoader, AttachmentReference } from '../../core/attachments.ts'
import type { SlackApi } from './api.ts'
import { downloadUrl, FILE_ID, fileInfo, openDownload } from './files.ts'

const DOWNLOAD_TIMEOUT_MS = 120000

export function fileName(file: any): string {
  return String(file?.name ?? file?.title ?? file?.id ?? 'file')
    .replace(/[\r\n]/g, ' ')
    .slice(0, 200)
}

export function attachmentReference(file: any): AttachmentReference | undefined {
  if (typeof file?.id !== 'string' || !FILE_ID.test(file.id)) return
  return { id: file.id, name: fileName(file) }
}

export function slackAttachmentLoader(
  api: SlackApi,
  token: string,
  download: typeof fetch = fetch,
): AttachmentLoader {
  return async (reference, signal) => {
    if (!FILE_ID.test(reference.id)) throw new Error('ID de archivo invalido')
    // URLs are refreshed from Slack, never accepted from message text or stored snapshots.
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)])
    const file = await fileInfo(api, reference.id, timeout)
    timeout.throwIfAborted()

    if (!file || file.id !== reference.id || file.is_external) {
      throw new Error('archivo no disponible en Slack')
    }

    const url = downloadUrl(file)

    return {
      name: fileName(file),
      mediaType: typeof file.mimetype === 'string' ? file.mimetype : undefined,
      bytes: Number.isSafeInteger(file.size) ? file.size : undefined,
      open: () => openDownload(url, token, download, timeout),
    }
  }
}
