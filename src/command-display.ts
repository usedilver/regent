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

const operations = new Map<string, string>([
  ['gh repo view', 'Consultando un repositorio en GitHub'],
  ['gh pr view', 'Consultando un PR en GitHub'],
  ['gh pr list', 'Consultando PRs en GitHub'],
  ['gh pr checks', 'Consultando verificaciones del PR'],
  ['gh api', 'Consultando la API de GitHub'],
  ['gh auth status', 'Comprobando acceso a GitHub'],
  ['which vercel', 'Comprobando disponibilidad de Vercel'],
  ['vercel --version', 'Comprobando la version de Vercel'],
  ['vercel ls', 'Consultando despliegues en Vercel'],
  ['vercel list', 'Consultando despliegues en Vercel'],
  ['vercel inspect', 'Consultando un despliegue en Vercel'],
  ...commands,
])
const summaries = new Map([...operations].map(([command, title]) => [`${command} [argumentos y resto ocultos]`, title]))

// Only literal vocabulary leaves this module, never parsed argument values.
// Summaries identify the first operation, not every step of a compound command.
export function commandDisplay(value: unknown): { command: string; title: string } | undefined {
  if (typeof value !== 'string' || value.length > 16000) return
  const summaryTitle = summaries.get(value)
  if (summaryTitle) return { command: value, title: summaryTitle }
  const command = value.trim().replace(/ +/g, ' ')
  const title = !/[^a-z -]/.test(value) ? commands.get(command) : undefined
  if (title) return { command, title }
  // Reject substitutions, multiline scripts and controls instead of guessing their meaning.
  if (/[\x00-\x1f\x7f$`]/.test(value)) return
  try {
    const tokens = parse(value, () => '')
    for (const [operation, title] of operations) {
      const prefix = operation.split(' ')
      if (prefix.every((word, i) => tokens[i] === word)) {
        return { command: `${operation} [argumentos y resto ocultos]`, title }
      }
    }
  } catch { /* Unparseable shell stays opaque. */ }
}
import { parse } from 'shell-quote'
