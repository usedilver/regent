const commands = new Map<string, string>([
  ['git status', 'Revisando cambios'],
  ['git status --short', 'Revisando cambios'],
  ['git status --porcelain', 'Revisando cambios'],
  ['git diff', 'Revisando cambios'],
  ['git diff --stat', 'Revisando cambios'],
  ['git diff --check', 'Revisando cambios'],
  ['git diff --cached', 'Revisando cambios'],
  ['git diff --cached --stat', 'Revisando cambios'],
])
for (const manager of ['npm', 'pnpm', 'yarn']) {
  for (const [script, title] of [['test', 'Ejecutando pruebas'], ['build', 'Compilando el proyecto'], ['lint', 'Revisando estilo'], ['typecheck', 'Verificando tipos']]) {
    commands.set(`${manager} run ${script}`, title)
    if (manager !== 'npm' || script === 'test') commands.set(`${manager} ${script}`, title)
  }
}

// Exact public command vocabulary, not a shell sanitizer or execution permission.
// Never return arbitrary arguments, paths, descriptions, or partial commands.
export function commandDisplay(value: unknown): { command: string; title: string } | undefined {
  if (typeof value !== 'string' || value.length > 120 || /[^a-z -]/.test(value)) return
  const command = value.trim().replace(/ +/g, ' ')
  const title = commands.get(command)
  return title ? { command, title } : undefined
}
