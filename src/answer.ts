/**
 * Consulta técnica desde el chat: una pregunta ("¿por qué…?", "¿cómo funciona…?")
 * no crea card ni sala — se responde en el hilo con base en el código. Corre
 * claude en modo print, solo lectura, en la raíz del workspace (hereda CLAUDE.md).
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { BRIDGE_DIR } from './env.ts'

export interface AnswerInput {
  text: string
  transcript?: string
  repos: Array<{ name: string }>
  processNotes?: string
}
export interface AnswerConfig { model: string; timeout_sec: number }

const ANSWER_TOOLS = 'Read,Glob,Grep,Bash(git log:*),Bash(git blame:*),Bash(git show:*)'
const MAX_PROCESS_NOTES = 4000

export function buildAnswerPrompt(i: AnswerInput): string {
  const repos = i.repos.length ? i.repos.map(r => `- ${r.name}`).join('\n') : '(ninguno detectado)'
  return `# Consulta técnica (NO es una tarea)

Alguien del equipo hizo una pregunta en Slack. Respondela con base en el CÓDIGO. Tu cwd es la raíz del workspace; repos que podés leer:
${repos}

Reglas:
- Leé antes de afirmar: citá \`archivo:línea\` de lo que respalda cada afirmación; lo que no encontraste, decilo ("no lo verifiqué").
- Respuesta para Slack: corta (hasta ~12 líneas), directa, en español, sin encabezados; rutas y código entre backticks.
- No propongas crear un card ni arrancar trabajo salvo que lo pidan. Si la pregunta en realidad pide un cambio, decilo en una línea: eso sería una tarea.
- Si hace falta un dato de producción o de un sistema al que no llegás desde acá, decilo en vez de suponer.
${i.processNotes ? `\n# Proceso y reglas del equipo\n\n${i.processNotes.slice(0, MAX_PROCESS_NOTES)}\n` : ''}
# Pregunta

${i.text}
${i.transcript ? `\n# Hilo de contexto\n\n${i.transcript}\n` : ''}`
}

/** null si claude falla o se pasa del timeout: el caller decide qué contestar. */
export function answerQuestion(input: AnswerInput, cfg: AnswerConfig, run: { cwd?: string } = {}): Promise<string | null> {
  const noMcp = path.join(BRIDGE_DIR, 'tmp', 'no-mcp.json')
  try { fs.mkdirSync(path.dirname(noMcp), { recursive: true }); if (!fs.existsSync(noMcp)) fs.writeFileSync(noMcp, '{"mcpServers":{}}') } catch { /* sin tmp: claude cargará los MCP */ }
  return new Promise(resolve => {
    const child = execFile(
      'claude', ['-p', '--output-format', 'text', '--model', cfg.model, '--allowed-tools', ANSWER_TOOLS, '--strict-mcp-config', '--mcp-config', noMcp],
      { cwd: run.cwd ?? BRIDGE_DIR, timeout: cfg.timeout_sec * 1000, maxBuffer: 4 * 1024 * 1024, env: process.env },
      (err, stdout) => {
        if (err) return resolve(null)
        const text = stdout.toString().trim()
        resolve(text || null)
      },
    )
    child.stdin?.end(buildAnswerPrompt(input))
  })
}
