import type { SlackApi } from './api.ts'

export const FILE_ID = /^F[A-Z0-9]+$/

/** Fresh file metadata from Slack, or a timeout; the lookup itself cannot be aborted. */
export async function fileInfo(api: SlackApi, id: string, timeout: AbortSignal): Promise<any> {
  let onAbort: () => void = () => {}

  try {
    timeout.throwIfAborted()
    const result: any = await Promise.race([
      api('files.info', { file: id }).catch(() => {
        throw new Error(
          'Slack no permitio consultar el archivo; revisa files:read y acceso a la conversacion',
        )
      }),
      new Promise((_, reject) => {
        onAbort = () => reject(new Error('tiempo de descarga agotado'))
        timeout.addEventListener('abort', onAbort, { once: true })
      }),
    ])

    return result.file
  } finally {
    timeout.removeEventListener('abort', onAbort)
  }
}

/** The private download URL, only when it points at Slack's own file host over HTTPS. */
export function downloadUrl(file: any): URL {
  let url: URL

  try {
    url = new URL(file.url_private_download ?? file.url_private)
  } catch {
    throw new Error('sin URL de descarga')
  }

  const trusted =
    url.protocol === 'https:' &&
    url.hostname === 'files.slack.com' &&
    !url.port &&
    !url.username &&
    !url.password

  if (!trusted) throw new Error('origen de descarga no autorizado')
  return url
}

/** The file's bytes as a stream. The bot token only ever travels to Slack's file host. */
export async function openDownload(
  url: URL,
  token: string,
  download: typeof fetch,
  timeout: AbortSignal,
): Promise<AsyncIterable<Uint8Array>> {
  const response = await download(url, {
    headers: { authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: timeout,
  }).catch(() => {
    timeout.throwIfAborted()
    throw new Error('fallo de descarga o redireccion no permitida')
  })

  if (!response.ok || !response.body) throw new Error(`Slack devolvio HTTP ${response.status}`)
  return response.body
}
