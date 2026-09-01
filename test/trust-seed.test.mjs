/**
 * Pre-siembra de aprobaciones de claude. Un agente que arranca en un prompt
 * ("trust this folder", "New MCP server found") queda bloqueado y el texto de
 * la fase termina contestando el diálogo.
 */
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let failed = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`) } catch (err) { failed++; console.error(`  ✗ ${name}: ${err.message}`) }
}

// misma lógica que ensureTrusted en launcher.ts
function findUp(name, from) {
  let cur = path.resolve(from)
  for (let i = 0; i < 12; i++) {
    const c = path.join(cur, name)
    if (fs.existsSync(c)) return c
    const parent = path.dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
  return null
}

function seed(cfgPath, dir) {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  cfg.projects ??= {}
  const proj = (cfg.projects[dir] ??= {})
  if (proj.hasTrustDialogAccepted !== true) proj.hasTrustDialogAccepted = true
  const mcpPath = findUp('.mcp.json', dir)
  if (mcpPath) {
    const declared = Object.keys(JSON.parse(fs.readFileSync(mcpPath, 'utf8')).mcpServers ?? {})
    proj.enabledMcpjsonServers ??= []
    proj.disabledMcpjsonServers ??= []
    const nuevos = declared.filter(n => !proj.enabledMcpjsonServers.includes(n) && !proj.disabledMcpjsonServers.includes(n))
    proj.enabledMcpjsonServers.push(...nuevos)
  }
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8')).projects[dir]
}
function fixture(mcp, existing = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-'))
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo)
  if (mcp) fs.writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: mcp }))
  const cfgPath = path.join(root, '.claude.json')
  fs.writeFileSync(cfgPath, JSON.stringify({ projects: Object.keys(existing).length ? { [repo]: existing } : {} }))
  return { repo, cfgPath, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

console.log('trust-seed:')

check('aprueba los MCP declarados por el repo (el caso n8n del monorepo)', () => {
  const f = fixture({ n8n: {}, 'database-prod': {}, 'telescope-l9-prod': {} })
  const p = seed(f.cfgPath, f.repo)
  assert.equal(p.hasTrustDialogAccepted, true)
  assert.deepEqual(p.enabledMcpjsonServers.sort(), ['database-prod', 'n8n', 'telescope-l9-prod'])
  f.cleanup()
})

check('respeta lo que el operador desactivó a mano', () => {
  const f = fixture({ n8n: {}, figma: {} }, { disabledMcpjsonServers: ['figma'], enabledMcpjsonServers: [] })
  const p = seed(f.cfgPath, f.repo)
  assert.deepEqual(p.enabledMcpjsonServers, ['n8n'])
  assert.deepEqual(p.disabledMcpjsonServers, ['figma'])
  f.cleanup()
})

check('es idempotente: no duplica en la segunda corrida', () => {
  const f = fixture({ n8n: {} })
  seed(f.cfgPath, f.repo)
  const p = seed(f.cfgPath, f.repo)
  assert.deepEqual(p.enabledMcpjsonServers, ['n8n'])
  f.cleanup()
})

check('repo sin .mcp.json: solo trust, sin claves de MCP', () => {
  const f = fixture(null)
  const p = seed(f.cfgPath, f.repo)
  assert.equal(p.hasTrustDialogAccepted, true)
  assert.equal(p.enabledMcpjsonServers, undefined)
  f.cleanup()
})

check('el caso real: .mcp.json en la raíz del monorepo, agente en un submódulo', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mono-'))
  const mono = path.join(root, 'talently-code')
  const sub = path.join(mono, 'frontend', 'frontend-hire')
  fs.mkdirSync(sub, { recursive: true })
  fs.writeFileSync(path.join(mono, '.mcp.json'), JSON.stringify({ mcpServers: { miro: {}, n8n: {}, 'database-prod': {} } }))
  const cfgPath = path.join(root, '.claude.json')
  fs.writeFileSync(cfgPath, JSON.stringify({ projects: {} }))
  const p = seed(cfgPath, sub)   // el agente corre en el submódulo, no en la raíz
  assert.deepEqual(p.enabledMcpjsonServers.sort(), ['database-prod', 'miro', 'n8n'])
  fs.rmSync(root, { recursive: true, force: true })
})

if (failed) { console.error(`\n${failed} fallaron`); process.exit(1) }
