/** Fixture: config de instancia (workflow.json + agents/) + carpeta de repos, para tests. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export function makeBridgeFixture(overrides = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cfg-'))
  const reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-repos-'))
  fs.mkdirSync(path.join(configDir, 'agents'), { recursive: true })

  const workflow = {
    status_property: 'Status',
    agent_filter: { property: 'Ejecutor', skip_value: 'Humano' },
    max_hops: 3,
    states: [
      { name: 'Backlog', group: 'To-do' },
      { name: 'Planning', group: 'In progress', trigger: 'planner', agent_moves_to: 'Plan Review' },
      { name: 'Plan Review', group: 'In progress', gate: 'human' },
      { name: 'In Progress', group: 'In progress', trigger: 'implementer', agent_moves_to: 'Testing', use_worktree: true },
      { name: 'Testing', group: 'In progress', gate: 'human' },
      { name: 'Done', group: 'Complete', terminal: true },
      { name: 'Canceled', group: 'Complete', terminal: true },
    ],
    agents: {
      planner: { allowed_tools: ['Read', 'Glob', 'Grep'], can_trigger: [] },
      implementer: { allowed_tools: ['Read', 'Edit', 'Bash(git:*)'], can_trigger: [] },
    },
    ...overrides.workflow,
  }
  fs.mkdirSync(path.join(configDir, 'config'), { recursive: true })
  fs.writeFileSync(path.join(configDir, 'config', 'workflow.json'), JSON.stringify(workflow, null, 2))

  const agents = overrides.agents ?? {
    planner: '---\nname: planner\ndescription: test planner\ntools: Read, Glob, Grep\n---\n\nEres el planner de prueba.',
    implementer: '---\nname: implementer\ndescription: test implementer\ntools: Read, Edit, Bash\n---\n\nEres el implementer de prueba.',
  }
  for (const [name, content] of Object.entries(agents)) {
    fs.writeFileSync(path.join(configDir, 'agents', `${name}.md`), content)
  }
  const cleanup = () => {
    fs.rmSync(configDir, { recursive: true, force: true })
    fs.rmSync(reposRoot, { recursive: true, force: true })
  }
  return { configDir, reposRoot, cleanup }
}
