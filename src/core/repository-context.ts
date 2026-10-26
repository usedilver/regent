import fs from 'node:fs'
import path from 'node:path'
import { isInside, resolveRepository, projectRoot } from './repository.ts'

const MAX_ENTRIES = 100
const SKILL_FOLDERS = ['.claude/skills', '.agents/skills']
const AGENT_FOLDERS = ['.claude/agents', '.agents/agents']
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md']

type Visible = (file: string) => boolean
type Named = { name: string; path: string }

/** From the project root down to the selected repository, root first. */
function directoriesBetween(project: string, repo: string): string[] {
  const directories: string[] = []

  for (let directory = repo; isInside(project, directory); directory = path.dirname(directory)) {
    directories.unshift(directory)
    if (directory === project) break
  }

  return directories
}

function skillsIn(root: string, directory: string, visible: Visible): Named[] {
  const seen = new Set<string>()
  const skills: Named[] = []

  for (const folder of SKILL_FOLDERS) {
    const location = path.join(directory, folder)
    if (!visible(location) || !fs.statSync(location).isDirectory()) continue

    for (const name of fs.readdirSync(location).sort().slice(0, MAX_ENTRIES)) {
      const skill = path.join(location, name, 'SKILL.md')
      if (!visible(skill) || !fs.statSync(skill).isFile()) continue
      const canonical = fs.realpathSync(skill)
      if (seen.has(canonical)) continue
      seen.add(canonical)
      skills.push({ name, path: path.relative(root, skill) })
    }
  }

  return skills
}

function agentsIn(root: string, directory: string, visible: Visible): Named[] {
  return AGENT_FOLDERS.flatMap((folder) => {
    const location = path.join(directory, folder)
    if (!visible(location) || !fs.statSync(location).isDirectory()) return []

    return fs
      .readdirSync(location)
      .sort()
      .slice(0, MAX_ENTRIES)
      .filter((name) => name.endsWith('.md') && visible(path.join(location, name)))
      .map((name) => ({
        name: name.slice(0, -3),
        path: path.relative(root, path.join(location, name)),
      }))
  })
}

function mcpServersIn(directory: string, visible: Visible) {
  const file = path.join(directory, '.mcp.json')
  if (!visible(file)) return { configured_mcp_servers: [] as string[], mcp_config_error: null }

  try {
    const servers = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers ?? {}
    return {
      configured_mcp_servers: Object.keys(servers).slice(0, MAX_ENTRIES),
      mcp_config_error: null,
    }
  } catch {
    return {
      configured_mcp_servers: [] as string[],
      mcp_config_error: 'No se pudo leer el JSON; no se verificaron sus conexiones.',
    }
  }
}

function directoryInventory(root: string, directory: string) {
  const visible: Visible = (file) => fs.existsSync(file) && isInside(root, fs.realpathSync(file))
  const instructionFiles = INSTRUCTION_FILES.map((name) => path.join(directory, name))
    .filter(visible)
    .map((file) => path.relative(root, file))

  return {
    directory: path.relative(root, directory) || '.',
    instruction_files: instructionFiles,
    skills: skillsIn(root, directory, visible),
    agents: agentsIn(root, directory, visible),
    ...mcpServersIn(directory, visible),
  }
}

type Inventory = ReturnType<typeof directoryInventory>

const hasContext = (entry: Inventory) =>
  Boolean(
    entry.instruction_files.length ||
      entry.skills.length ||
      entry.agents.length ||
      entry.configured_mcp_servers.length ||
      entry.mcp_config_error,
  )

/** What the agent will find declared in the repo: instructions, skills, agents and MCP servers. */
export function repositoryContext(workspace: string, selected: string) {
  const root = fs.realpathSync(workspace)
  const repo = resolveRepository(root, selected)
  const project = projectRoot(root, repo)
  const inventory = directoriesBetween(project, repo)
    .map((directory) => directoryInventory(root, directory))
    .filter(hasContext)

  return {
    workspace: root,
    repo,
    project_root: project,
    relative_repo: path.relative(root, repo) || '.',
    instruction_directories: inventory,
    inventory_only: true,
    note: 'Son archivos y conexiones declaradas; el agente carga las instrucciones y verifica las fuentes al ejecutar. El cliente de chat no recibe automaticamente las skills ni las conexiones del repo.',
  }
}
