/**
 * Consulta técnica desde el chat: una pregunta ("¿por qué…?", "¿cómo funciona…?")
 * no crea card ni sala — se responde en el hilo con base en el código y, si el
 * repo trae MCP (base de datos, telescope…), también con datos. Corre claude en
 * modo print en la raíz del workspace, con el mismo .env que reciben los agentes.
 */
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { BRIDGE_DIR, loadAgentEnv } from './env.ts'
import { ensureTrusted, findUp } from './claude-settings.ts'

export interface AnswerInput {
  text: string
  transcript?: string
  repos: Array<{ name: string }>
  processNotes?: string
}
export interface AnswerConfig { model: string; timeout_sec: number }
export interface AnswerRun { cwd?: string; envFiles?: string[] }

const READ_TOOLS = ['Read', 'Glob', 'Grep', 'Bash(git log:*)', 'Bash(git blame:*)', 'Bash(git show:*)']
const MAX_PROCESS_NOTES = 4000

/** Servidores del .mcp.json que aplica al cwd (hacia arriba, como los busca claude). */
export function mcpServersFor(cwd?: string): string[] {
  const file = cwd ? findUp('.mcp.json', cwd) : null
  if (!file) return []
  try { return Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers ?? {}) } catch { return [] }
}

/** Flags de claude para la consulta: solo lectura del repo + todos los MCP que el repo declara. */
export function answerArgs(model: string, cwd?: string): string[] {
  const tools = [...READ_TOOLS, ...mcpServersFor(cwd).map(n => `mcp__${n}`)]
  return ['-p', '--output-format', 'text', '--model', model, '--allowed-tools', tools.join(',')]
}

export function buildAnswerPrompt(i: AnswerInput): string {
  const repos = i.repos.length ? i.repos.map(r => `- ${r.name}`).join('\n') : '(ninguno detectado)'
  return `# Consulta técnica (NO es una tarea)

Alguien del equipo hizo una pregunta en Slack. Respondela con base en el CÓDIGO y, si hace falta, en DATOS (los MCP del repo que tengas: base de datos, telescope, etc.). Tu cwd es la raíz del workspace; repos que podés leer:
${repos}

Reglas:
- Leé antes de afirmar: citá \`archivo:línea\` de lo que respalda cada afirmación; lo que no encontraste, decilo ("no lo verifiqué").
- Datos: solo consultas de LECTURA (SELECT). Nunca modifiques nada. Decí qué consultaste y cuántas filas respaldan la respuesta.
- Respuesta para Slack: corta (hasta ~12 líneas), directa, en español, sin encabezados; rutas y código entre backticks.
- No propongas crear un card ni arrancar trabajo salvo que lo pidan. Si la pregunta en realidad pide un cambio, decilo en una línea: eso sería una tarea.
- Si te falta acceso a algo, decilo en vez de suponer.
- Tu salida se publica TAL CUAL: solo el texto final de la respuesta, sin notas previas, sin "Respuesta para Slack:" ni razonamiento.
${i.processNotes ? `\n# Proceso y reglas del equipo\n\n${i.processNotes.slice(0, MAX_PROCESS_NOTES)}\n` : ''}
# Pregunta

${i.text}
${i.transcript ? `\n# Hilo de contexto\n\n${i.transcript}\n` : ''}`
}

/** null si claude falla o se pasa del timeout: el caller decide qué contestar. */
export function answerQuestion(input: AnswerInput, cfg: AnswerConfig, run: AnswerRun = {}): Promise<string | null> {
  if (run.cwd) ensureTrusted(run.cwd) // los MCP del repo ya aprobados: en -p no hay diálogo, se saltan
  const env = { ...process.env, ...loadAgentEnv(run.envFiles ?? []).vars }
  return new Promise(resolve => {
    const child = execFile(
      'claude', answerArgs(cfg.model, run.cwd),
      { cwd: run.cwd ?? BRIDGE_DIR, timeout: cfg.timeout_sec * 1000, maxBuffer: 4 * 1024 * 1024, env },
      (err, stdout) => {
        if (err) return resolve(null)
        const text = stdout.toString().trim()
        resolve(text || null)
      },
    )
    child.stdin?.end(buildAnswerPrompt(input))
  })
}
