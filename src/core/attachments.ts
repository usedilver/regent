import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const ATTACHMENT_BYTES = 50 * 1024 * 1024
export const ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000

const SAFE_ID = /^[A-Za-z0-9]{1,64}$/

export interface AttachmentReference {
  id: string
  name: string
}

/** A file the adapter can stream. Its transport credentials never leave the adapter. */
export interface AttachmentSource {
  name: string
  mediaType?: string
  bytes?: number
  open(): Promise<AsyncIterable<Uint8Array>>
}

export type AttachmentLoader = (
  reference: AttachmentReference,
  signal: AbortSignal,
) => Promise<AttachmentSource>

export interface SavedAttachment {
  file_id: string
  name: string
  path: string
  bytes: number
  media_type?: string
}

/** A name that is safe as a single path segment and keeps its extension. */
function safeName(name: string, fallback: string): string {
  const base = path
    .basename(name.replaceAll('\\', '/'))
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^[._]+/, '')
    .slice(-120)

  return base || fallback
}

async function sizeOf(file: string): Promise<number | undefined> {
  return (await fs.promises.stat(file).catch(() => undefined))?.size
}

/**
 * Conversation attachments downloaded to a directory Regent owns, outside every repository
 * and worktree, so they are never committed and do not block worktree cleanup. The agent
 * receives the path and opens the file with its own tools.
 */
export class Attachments {
  root: string

  constructor(root: string) {
    this.root = root
  }

  directory(key: string): string {
    return path.join(this.root, createHash('sha256').update(key).digest('hex').slice(0, 24))
  }

  async save(
    key: string,
    reference: AttachmentReference,
    loader: AttachmentLoader,
    signal: AbortSignal,
  ): Promise<SavedAttachment> {
    if (!SAFE_ID.test(reference.id)) throw new Error('Invalid attachment id.')
    const source = await loader(reference, signal)
    signal.throwIfAborted()
    const home = this.directory(key)
    const directory = path.join(home, reference.id)
    const file = path.join(directory, safeName(source.name, reference.id))
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 })

    // A complete earlier download is reused; an edited file has another size and is replaced.
    if (source.bytes === undefined || (await sizeOf(file)) !== source.bytes) {
      await this.download(source, file, signal)
    }

    const now = new Date()
    await fs.promises.utimes(home, now, now)

    return {
      file_id: reference.id,
      name: path.basename(file),
      path: file,
      bytes: (await sizeOf(file)) ?? 0,
      ...(source.mediaType ? { media_type: source.mediaType } : {}),
    }
  }

  /** Streams to a temporary name so a failed or oversized download never looks complete. */
  private async download(
    source: AttachmentSource,
    file: string,
    signal: AbortSignal,
  ): Promise<void> {
    const limit = `The attachment exceeds the ${ATTACHMENT_BYTES / 1024 / 1024} MiB download limit.`
    if ((source.bytes ?? 0) > ATTACHMENT_BYTES) throw new Error(limit)
    const partial = `${file}.${randomBytes(6).toString('hex')}.part`
    const handle = await fs.promises.open(partial, 'wx', 0o600)
    let bytes = 0

    try {
      for await (const chunk of await source.open()) {
        signal.throwIfAborted()
        bytes += chunk.length
        if (bytes > ATTACHMENT_BYTES) throw new Error(limit)
        await handle.write(chunk)
      }

      await handle.close()
      await fs.promises.rename(partial, file)
    } catch (error) {
      await handle.close().catch(() => {})
      await fs.promises.rm(partial, { force: true })
      throw error
    }
  }

  async remove(key: string): Promise<void> {
    await fs.promises.rm(this.directory(key), { recursive: true, force: true })
  }

  /** Removes conversations whose attachments were last requested before the retention window. */
  async sweep(now = Date.now()): Promise<number> {
    const entries = await fs.promises.readdir(this.root, { withFileTypes: true }).catch(() => [])
    let removed = 0

    for (const entry of entries) {
      const directory = path.join(this.root, entry.name)
      const stat = await fs.promises.stat(directory).catch(() => undefined)
      if (!stat || now - stat.mtimeMs < ATTACHMENT_TTL_MS) continue
      await fs.promises.rm(directory, { recursive: true, force: true })
      removed++
    }

    return removed
  }
}
