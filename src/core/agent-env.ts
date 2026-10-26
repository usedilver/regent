import type { Config } from '../config.ts'
import { agentEnvFiles, loadAgentEnv } from '../env.ts'

const SLACK_TRANSPORT_KEYS = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET']

/**
 * The environment the Claude subprocess runs with: the operator's process environment plus the
 * repository's own .env files, minus every credential that belongs to Regent rather than the repo.
 */
export function agentEnvironment(
  config: Config,
  ownSecrets: string[],
  repoCwd: string,
): NodeJS.ProcessEnv {
  // The repo's own environment, so its .mcp.json variables resolve.
  const repoVars = loadAgentEnv(agentEnvFiles(config.repos.agent_env_files, repoCwd)).vars
  const env: NodeJS.ProcessEnv = { ...process.env }

  // Regent's service secrets (Slack, Notion, GitHub) never reach the agent, unless the repo
  // re-provides that exact key in its own .env.
  for (const key of ownSecrets) {
    if (!(key in repoVars)) delete env[key]
  }

  Object.assign(env, repoVars)

  // Transport credentials stay private even when supplied by systemd instead of .env.
  for (const key of SLACK_TRANSPORT_KEYS) delete env[key]
  for (const principal of config.mcp.principals) delete env[principal.token_env]
  if (config.mcp.oauth) delete env[config.mcp.oauth.oidc.client_secret_env]
  delete env.REGENT_MCP_TOKEN
  delete env.REGENT_MCP_URL

  // The operator's API identity is Regent's, not the repo's: take it from process.env only.
  if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
  else delete env.ANTHROPIC_API_KEY

  return env
}
