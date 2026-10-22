import fs from 'node:fs'
import path from 'node:path'
import { resolveRepository, projectRoot } from './repository.ts'

const MAX_ENTRIES = 100
const within = (root: string, target: string) => {
  const relative = path.relative(root, target)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export function repositoryContext(workspace: string, selected: string) {
  const root = fs.realpathSync(workspace)
  const repo = resolveRepository(root, selected)
  const project = projectRoot(root, repo)
  const visible = (file: string) => fs.existsSync(file) && within(root, fs.realpathSync(file))
  const directories: string[] = []
  for (let directory = repo; within(project, directory); directory = path.dirname(directory)) {
    directories.unshift(directory)
    if (directory === project) break
  }
  const inventory = directories.map(directory => {
    const seen = new Set<string>()
    const skills: Array<{ name: string; path: string }> = []
    for (const folder of ['.claude/skills', '.agents/skills']) {
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
    const agents = ['.claude/agents', '.agents/agents'].flatMap(folder => {
      const location = path.join(directory, folder)
      if (!visible(location) || !fs.statSync(location).isDirectory()) return []
      return fs.readdirSync(location).sort().slice(0, MAX_ENTRIES)
        .filter(name => name.endsWith('.md') && visible(path.join(location, name)))
        .map(name => ({ name: name.slice(0, -3), path: path.relative(root, path.join(location, name)) }))
    })
    const instructionFiles = ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md']
      .map(name => path.join(directory, name)).filter(visible).map(file => path.relative(root, file))
    const mcpFile = path.join(directory, '.mcp.json')
    let configuredMcp: string[] = []
    let mcpConfigError: string | null = null
    if (visible(mcpFile)) {
      try { configuredMcp = Object.keys(JSON.parse(fs.readFileSync(mcpFile, 'utf8')).mcpServers ?? {}).slice(0, MAX_ENTRIES) }
      catch { mcpConfigError = 'No se pudo leer el JSON; no se verificaron sus conexiones.' }
    }
    return { directory: path.relative(root, directory) || '.', instruction_files: instructionFiles, skills, agents,
      configured_mcp_servers: configuredMcp, mcp_config_error: mcpConfigError }
  }).filter(entry => entry.instruction_files.length || entry.skills.length || entry.agents.length || entry.configured_mcp_servers.length || entry.mcp_config_error)
  return { workspace: root, repo, project_root: project, relative_repo: path.relative(root, repo) || '.', instruction_directories: inventory,
    inventory_only: true, note: 'Son archivos y conexiones declaradas; el agente carga las instrucciones y verifica las fuentes al ejecutar. El cliente de chat no recibe automaticamente las skills ni las conexiones del repo.' }
}
