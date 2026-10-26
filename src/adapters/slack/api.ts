/** A Web API call: `method` is the Slack method name, `args` its JSON arguments. */
export type SlackApi = (method: string, args: Record<string, any>) => Promise<any>

/** Slack's error code when the SDK attached one, otherwise the plain message. */
export function slackErrorCode(error: unknown): string {
  const failure = error as { data?: { error?: string }; message?: string } | undefined
  return failure?.data?.error ?? failure?.message ?? ''
}

/** Whether the failure carries that Slack error code, in its data or in its message. */
export function isSlackError(error: unknown, code: string): boolean {
  const failure = error as { data?: { error?: string }; message?: string } | undefined
  if (failure?.data?.error === code) return true
  return new RegExp(`\\b${code}\\b`).test(failure?.message ?? '')
}
