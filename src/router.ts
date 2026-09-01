/**
 * Router de triggers — funciones puras (testeables sin Notion).
 *
 * Tres vías de activación:
 *   column   — el card entra a una columna con trigger (Fase 1)
 *   mention  — un comentario contiene la mención de un agent (@qa)
 *   created  — se crea un card en el board (triage)
 *
 * Handoffs agente→agente: un comentario DEL BOT con mención se procesa solo si
 * el agent actual del card (propiedad Agente) tiene al target en can_trigger y
 * no se superó max_hops. Los comentarios humanos resetean el contador (hop 0).
 */
import type { BridgeConfig } from './bridge-config.ts'

export type TriggerMode = 'column' | 'mention' | 'created'

/** Agents cuyas menciones aparecen en el texto (case-insensitive), en orden de config. */
export function findMentionTargets(text: string, config: BridgeConfig): string[] {
  const t = text.toLowerCase()
  const out: string[] = []
  for (const [name, a] of Object.entries(config.agents)) {
    const mentions = a.triggers?.mentions ?? []
    if (mentions.some(m => t.includes(m.toLowerCase()))) out.push(name)
  }
  return out
}

/** El agent (si hay) que se activa cuando se crea un card. */
export function pageCreatedAgent(config: BridgeConfig): string | undefined {
  return Object.entries(config.agents).find(([, a]) => a.triggers?.page_created)?.[0]
}

export interface HandoffVerdict {
  ok: boolean
  reason?: string
  nextHop: number
}

/**
 * Evalúa un handoff bot→agent. `sourceAgent` = valor de la propiedad Agente del card
 * (el último agent que corrió); `currentHops` = propiedad Hop del card.
 */
export function evaluateHandoff(
  sourceAgent: string | undefined,
  targetAgent: string,
  currentHops: number,
  config: BridgeConfig,
): HandoffVerdict {
  const nextHop = currentHops + 1
  if (!sourceAgent) return { ok: false, reason: 'card sin propiedad Agente: no sé quién origina el handoff', nextHop }
  const source = config.agents[sourceAgent]
  if (!source) return { ok: false, reason: `agent origen "${sourceAgent}" no existe en .bridge`, nextHop }
  if (!source.can_trigger.includes(targetAgent)) {
    return { ok: false, reason: `"${sourceAgent}" no tiene a "${targetAgent}" en can_trigger`, nextHop }
  }
  if (nextHop > config.max_hops) {
    return { ok: false, reason: `max_hops (${config.max_hops}) alcanzado`, nextHop }
  }
  return { ok: true, nextHop }
}
