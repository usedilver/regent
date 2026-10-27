# Repository Guidelines

Regent is a conversational Slack/MCP/CLI client for the official Claude Code CLI.
Keep it project-agnostic: repositories supply skills, MCPs and business workflows.
Read [ARCHITECTURE.md](ARCHITECTURE.md) and [CONTRIBUTING.md](CONTRIBUTING.md) before changing shared behavior.

## Layout and boundaries

- `src/core/`: execution/session coordination, repositories, history and shared contracts.
- `src/execution/`: official CLI subprocess, prompts and native repository settings.
- `src/adapters/`: Slack, MCP and loopback HTTP. Core/storage do not import adapter SDKs.
- `src/storage/`: SQLite, durable output and redaction. Preserve migrations and restart behavior.
- `src/runtime.ts`: shared server lifecycle. Add cleanup here, including failed startup.
- `src/server.ts`, `src/mcp-server.ts`, `src/cli.ts`, `src/mcp-client.ts`: stable entrypoints.
- `plugins/executor/`: internal protocol, default communication policy and hooks.
- `plugins/regent/`: generic public client. Branded distributions live in their owner's repository.
- `config/`: public templates and ignored operator settings. Never stage local instance files.
- `test/`: automatic suites; `fixtures/` for simulations, `smoke/` for opt-in real providers.
- `dist/plugins/`: ignored versioned ZIPs/checksums; generated from the packaging allowlist.

## Checks and style

Use `.nvmrc` and pnpm pinned in `package.json`. `pnpm check` matches the main CI job:
Prettier, strict TypeScript and automatic `test/**/*.test.mjs` discovery. Use `pnpm format`
for mechanical formatting. Do not register individual test filenames in package scripts.
New tests use `node:test`; validate meaningful behavior rather than source formatting.
`pnpm check:image` additionally verifies the Docker image and its runtime resources.

Use explicit ESM imports and type shared states/events and tool arguments. Prefer existing
helpers and focused modules; do not introduce mandatory boards, tickets, approval pipelines
or feature inventories into prompts and instructions. Documentation explains stable contracts,
not a changelog for every feature. Instance communication policy controls presentation, not authorization.
Write agent-facing prompts, tool instructions and client guidance in English. Preserve original
user/history content and answer in the user's language; localized user-facing notices are separate.

## Compatibility and delivery

Keep public tools, OAuth/session contracts, worktrees, ignored configuration and `log/v2.sqlite`
compatible. Do not change public identifiers just because source directories move. Validate
cancel/restart/deduplication/permissions and failure cleanup when changing execution or adapters.
Distinguish fake integration checks from real Slack/Claude/provider verification.

Make focused Conventional Commits in English. Keep PRs reviewable and report validation and
material limitations. Contributor verification must work without access to an internal tracker.
Maintainer planning and local execution records can remain outside the public source tree.

## Security

Never extract, copy or forward Claude credentials; use the unmodified official CLI and the
operator's normal authentication. Follow CONTRIBUTING.md. Do not stage secrets, sensitive
transcripts or instance credentials in public plugins. Hooks are not an OS sandbox. Keep core
policy and transport authorization separate from presentation and application preview login.
