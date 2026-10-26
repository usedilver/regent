import type { IncomingMessage } from 'node:http'

export class BodyTooLarge extends Error {
  constructor() {
    super('Request body over the size limit.')
  }
}

export class InvalidJson extends Error {
  constructor() {
    super('Request body is not valid JSON.')
  }
}

/** The request body parsed as JSON. Stops reading as soon as the limit is crossed. */
export async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new BodyTooLarge()
    chunks.push(Buffer.from(chunk))
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new InvalidJson()
  }
}

export function bearerToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization ?? ''
  return /^Bearer /i.test(authorization) ? authorization.slice(7).trim() : ''
}
