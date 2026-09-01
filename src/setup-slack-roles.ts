#!/usr/bin/env node
/**
 * Caras REALES por rol: crea una app de identidad de Slack por cada agent del
 * workflow (via apps.manifest.create) para que @Planner, @Dev, @QA… sean
 * menciones de verdad (autocompletado, avatar, presencia).
 *
 * Las apps de rol NO llevan proceso: sin Socket Mode, sin eventos, sin servidor.
 * Solo existen (bot user mencionable) y hablan (chat:write con su token). El hub
 * (regent) es el único que escucha y traduce <@U_rol> → rol → launch.
 *
 * Requiere un App Configuration Token (api.slack.com/apps → "Your App
 * Configuration Tokens" → Generate) en .env como SLACK_CONFIG_TOKEN. Expira a
 * las 12h — si este script dice token_expired, genera otro.
 *
 * Lo único que Slack no deja automatizar es el clic de instalación: por cada
 * app el script imprime el link, tú instalas (Allow) y pegas el token xoxb.
 * Re-ejecutable: salta roles que ya tienen token en .env.
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { BRIDGE_DIR, loadEnv } from './env.ts'
import { loadBridge } from './bridge-config.ts'
import { slackApi, createAppFromManifest, installUrl } from './slack-admin.ts'

loadEnv()
const bridge = loadBridge()
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const REGISTRY = path.join(BRIDGE_DIR, 'log', 'slack-role-apps.json')
const ENV_PATH = path.join(BRIDGE_DIR, '.env')

export const envKeyForRole = (role: string): string => `SLACK_BOT_TOKEN_${role.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`

/** manifest mínimo de una cara: identidad + chat:write. Nada más. */
function roleManifest(displayName: string, description?: string): Record<string, unknown> {
  // el short description admite 140 BYTES (los acentos cuentan doble) → primera oración, tope 100 chars
  const short = (description ?? 'Rol del pipeline regent').split(/(?<=\.)\s/)[0].slice(0, 100)
  return {
    display_information: {
      name: displayName.slice(0, 35),
      description: short,
    },
    features: { bot_user: { display_name: displayName.slice(0, 80), always_online: true } },
    oauth_config: { scopes: { bot: ['chat:write'] } },
  }
}

function appendEnv(key: string, value: string): void {
  let env = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : ''
  if (new RegExp(`^${key}=`, 'm').test(env)) env = env.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}="${value}"`)
  else env += `${env.endsWith('\n') || env === '' ? '' : '\n'}${key}="${value}"\n`
  fs.writeFileSync(ENV_PATH, env, { mode: 0o600 })
  fs.chmodSync(ENV_PATH, 0o600) // writeFileSync ignora mode si el archivo ya existía
}

const cfgToken = process.env.SLACK_CONFIG_TOKEN
  ?? (await rl.question('App Configuration Token (xoxe.xoxp-…, de api.slack.com/apps): ')).trim()
if (!cfgToken) {
  console.error('sin token de configuración no puedo crear apps — genera uno en api.slack.com/apps → Your App Configuration Tokens')
  process.exit(1)
}

let registry: Record<string, { app_id: string; name: string }> = {}
try { registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) } catch { /* primera vez */ }

const roles = Object.entries(bridge.config.agents)
console.log(`\nRoles del workflow: ${roles.map(([r]) => r).join(', ')}\n`)

for (const [role, a] of roles) {
  const key = envKeyForRole(role)
  if (process.env[key]) { console.log(`✓ ${role} — token ya en .env (${key})`); continue }

  const displayName = (a.chat?.username ?? role).replace(/\p{Extended_Pictographic}/gu, '').replace(/[\u200d\ufe0f]/g, '').trim() || role
  let appId = registry[role]?.app_id
  if (!appId) {
    const description = bridge.agents.get(role)?.description
    try {
      appId = await createAppFromManifest(cfgToken, roleManifest(displayName, description),
        seg => console.log(`   ratelimited — espero ${seg}s y reintento…`))
      registry[role] = { app_id: appId, name: displayName }
      fs.mkdirSync(path.dirname(REGISTRY), { recursive: true })
      fs.writeFileSync(REGISTRY, JSON.stringify(registry, null, 2))
      console.log(`🆕 ${role} — app "${displayName}" creada (${appId})`)
    } catch (err) {
      console.error(`✗ ${role} — ${(err as Error).message}${/token_expired|invalid_auth/.test((err as Error).message) ? ' → genera un token de configuración nuevo (expiran a las 12h)' : ''}`)
      continue
    }
  } else {
    console.log(`↺ ${role} — app "${registry[role].name}" ya creada (${appId}), falta instalarla`)
  }

  console.log(`   1. Instálala (clic en "Install to Workspace" → Allow):`)
  console.log(`      ${installUrl(appId)}`)
  console.log(`   2. Copia el "Bot User OAuth Token" (xoxb-…) que aparece tras instalar`)
  const token = (await rl.question(`   → token de ${displayName} (enter para dejar pendiente): `)).trim()
  if (!token) { console.log(`   ⏭ ${role} pendiente — re-ejecuta este script cuando lo tengas\n`); continue }

  try {
    const who = await slackApi('auth.test', token)
    appendEnv(key, token)
    console.log(`   ✅ ${role} → @${who.user} (${who.user_id}) — guardado en .env como ${key}\n`)
  } catch (err) {
    console.error(`   ✗ token inválido: ${(err as Error).message} — ${role} queda pendiente\n`)
  }
}

rl.close()
console.log('Listo. El server toma los tokens al reiniciar (pnpm dev con watch de .env lo hace solo).')
console.log('Opcional: ponles avatar en api.slack.com/apps → cada app → Basic Information (la API de manifests no sube íconos).')
