/**
 * Administración de apps de Slack vía App Configuration Token.
 *
 * Lo que Slack SÍ deja automatizar: crear la app desde un manifest
 * (`apps.manifest.create`). Lo que NO, y por eso queda como clic del operador:
 * instalar la app en el workspace, y generar el token app-level de Socket Mode
 * (solo existe en Basic Information; no hay método de API — verificado contra
 * docs.slack.dev el 2026-09-01).
 */
import fs from 'node:fs'

export async function slackApi(
  method: string,
  token: string,
  body: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json() as { ok: boolean; error?: string } & Record<string, unknown>
  if (!json.ok) throw new Error(`${method} → ${json.error}`)
  return json
}

/** `apps.manifest.create` tiene rate limit agresivo (~1/min): backoff y reintento. */
export async function createAppFromManifest(
  cfgToken: string,
  manifest: Record<string, unknown>,
  onRetry?: (seg: number) => void,
): Promise<string> {
  for (let intento = 1; ; intento++) {
    try {
      const created = await slackApi('apps.manifest.create', cfgToken, { manifest: JSON.stringify(manifest) })
      return created.app_id as string
    } catch (err) {
      if (!/ratelimited/.test((err as Error).message) || intento >= 4) throw err
      onRetry?.(65)
      await new Promise(r => setTimeout(r, 65000))
    }
  }
}

/**
 * Toma el manifest del repo y le pone la identidad de ESTA instancia: el equipo
 * elige cómo se llama su hub, y el nombre no debe quedar cableado al del proyecto.
 */
export function brandManifest(manifestPath: string, appName: string): Record<string, unknown> {
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    display_information: { name: string }
    features?: { bot_user?: { display_name?: string } }
  }
  m.display_information.name = appName.slice(0, 35)
  if (m.features?.bot_user) m.features.bot_user.display_name = appName.slice(0, 80)
  return m as unknown as Record<string, unknown>
}

export const installUrl = (appId: string): string => `https://api.slack.com/apps/${appId}/install-on-team`
export const appTokenUrl = (appId: string): string => `https://api.slack.com/apps/${appId}/general#app_level_tokens`
