/**
 * El prompt debe nombrar las propiedades del CLIENTE y sus valores exactos:
 * escribir "S" en un select cuyas opciones son "🟢 S" falla en silencio.
 */
import assert from 'node:assert'
import { buildPhasePrompt } from '../src/phase-prompt.ts'

let failed = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`) } catch (err) { failed++; console.error(`  ✗ ${name}: ${err.message}`) }
}
const base = { cardJson: '{}', pageId: 'x', ncardPath: './ncard', mode: 'column', nextState: 'In testing' }

console.log('prompt-props:')

check('nombra la propiedad del board y sus valores exactos', () => {
  const p = buildPhasePrompt({ ...base, props: { estimation: 'Effort', estimationValues: ['🟢 S', '🟡 M'], pr: 'PR' } })
  assert.match(p, /propiedad `Effort`/)
  assert.match(p, /`🟢 S`/)
  assert.doesNotMatch(p, /setselect <page_id> "Estimación"/)
})

check('board sin propiedad de estimación: le dice que no la invente', () => {
  const p = buildPhasePrompt({ ...base, props: { estimation: null, estimationValues: [], pr: 'PR' } })
  assert.match(p, /no la inventes/)
})

check('prohíbe duplicar en el cuerpo lo que vive en propiedades', () => {
  const p = buildPhasePrompt({ ...base, props: { estimation: 'Effort', estimationValues: ['🟢 S'], pr: 'PR' } })
  assert.match(p, /NO lo repitas en el cuerpo/)
  assert.match(p, /dos verdades/)
})

check('usa el nombre real de la propiedad de PR', () => {
  const p = buildPhasePrompt({ ...base, props: { estimation: null, estimationValues: [], pr: 'Pull Request' } })
  assert.match(p, /propiedad `Pull Request`/)
})

check('workspace en la raíz: checkouts compartidos solo lectura, regent-wt para escribir', () => {
  const p = buildPhasePrompt({ ...base, workspace: { root: '/w/talently-code', isRoot: true, worktreesDir: '/r/worktrees/abc', wtTool: '/r/regent-wt',
    repos: [{ repo: '/w/talently-code/frontend/frontend-hire', dir: '/r/worktrees/abc/frontend-hire', branch: 'agent/abc', base: 'develop' }] } })
  assert.match(p, /RAÍZ del workspace: `\/w\/talently-code`/)
  assert.match(p, /SOLO LECTURA/)
  assert.match(p, /regent-wt add <ruta-del-repo>/)
  assert.match(p, /\*\*frontend-hire\*\* → `\/r\/worktrees\/abc\/frontend-hire` \(rama `agent\/abc` desde `develop`\)/)
  assert.match(p, /un PR por repo cambiado/)
  assert.match(p, /regent-wt pr <repo> <url>/)
})

check('sin workspace_root: el cwd ES el worktree, y regent-wt sigue disponible para un segundo repo', () => {
  const p = buildPhasePrompt({ ...base, workspace: { root: '/r/worktrees/abc/api', isRoot: false, worktreesDir: '/r/worktrees/abc', wtTool: '/r/regent-wt', repos: [] } })
  assert.match(p, /Tu cwd es un \*\*worktree aislado\*\*: `\/r\/worktrees\/abc\/api`/)
  assert.match(p, /OTRO repo/)
  assert.doesNotMatch(p, /RAÍZ del workspace/)
})

check('sin workspace: no hay bloque git', () => {
  const p = buildPhasePrompt({ ...base })
  assert.doesNotMatch(p, /# Entorno git/)
})

if (failed) { console.error(`\n${failed} fallaron`); process.exit(1) }
