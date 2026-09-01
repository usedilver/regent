#!/usr/bin/env node
/**
 * validate — valida la configuración del repo cliente (.bridge/workflow.json + .claude/agents).
 * Uso: node src/validate.ts [repo_path]   (default: REPO_PATH del .env)
 * Exit 0 = válido. Lo usa el skill crear-agente y sirve como doctor de config.
 */
import { loadEnv } from './env.ts'
import { loadBridge } from './bridge-config.ts'
import { pageCreatedAgent } from './router.ts'

import fs from 'node:fs'
import path from 'node:path'
loadEnv()
try {
  const b = loadBridge(process.argv[2])
  console.log(`✓ config: ${b.configDir}`)
  console.log(`  estados: ${b.config.states.map(s => s.name + (s.trigger ? `→${s.trigger}` : '')).join(' · ')}`)
  for (const [name, a] of Object.entries(b.config.agents)) {
    const native = b.agents.get(name)!
    const trig = [
      ...(a.triggers?.mentions ?? []),
      ...(a.triggers?.page_created ? ['page_created'] : []),
      ...(b.config.states.some(s => s.trigger === name) ? ['columna'] : []),
    ]
    console.log(`  agent ${name}: triggers=[${trig.join(', ') || '—'}] can_trigger=[${a.can_trigger.join(', ') || '—'}] tools=${a.allowed_tools.length} model=${native.model ?? '(default)'}`)
  }
  const orphans = [...b.agents.keys()].filter(n => !b.config.agents[n] && !b.config.states.some(s => s.trigger === n))
  if (orphans.length) console.log(`  ⚠ agents en .claude/agents sin config en .bridge (no se activan): ${orphans.join(', ')}`)
  if (!pageCreatedAgent(b.config)) console.log('  ℹ sin agent de page_created: los cards nuevos no se procesan automáticamente (activación por drag/mención)')
  const reposRoot = (process.env.REPO_PATH ?? '').replace(/^~/, process.env.HOME ?? '')
  if (!reposRoot || !fs.existsSync(reposRoot)) {
    console.log(`  ✗ REPO_PATH no existe: "${reposRoot}"`)
  } else {
    const repos = fs.readdirSync(reposRoot).filter(d => fs.existsSync(path.join(reposRoot, d, '.git')))
    console.log(`  repos en ${reposRoot}: ${repos.length} (el card elige con su propiedad Repo; sin Repo no se ejecuta)`)
  }
} catch (err) {
  console.error(`✗ ${(err as Error).message}`)
  process.exit(1)
}
