# Repository Guidelines

## Project Structure & Architecture

Regent is a conversational Slack client for the official Claude Code CLI. Keep it
project-agnostic: repositories supply skills, MCPs, rules, and business workflows.
Do not reintroduce mandatory boards, tickets, or approval pipelines.

- `src/`: TypeScript runtime. `server.ts` starts Slack; `cli.ts` provides local
  commands; `core.ts`, `runner.ts`, and `store.ts` handle execution and persistence.
- `plugin/`: CLI protocol and permission hooks, not business-specific skills.
- `test/`: executable tests, fake Claude process, and IPC fixtures.
- `config/regent.yaml`: ignored instance configuration; see `regent.example.yaml`.
- `docs/`: architecture, investigations, and deployment guidance. Historical
  deployment instructions live in `docs/archive/`.
- `slack-manifest.json`: Slack app configuration. There is no frontend asset tree.

## Development Commands

Use Node 22.20.0 or a compatible version and pnpm pinned by `packageManager`.

- `pnpm install --frozen-lockfile`: install reproducible dependencies.
- `pnpm dev`: run Slack with file watching.
- `pnpm start`: run the server without watching.
- `pnpm test`: run the complete automated suite.
- `pnpm regent setup --repo /path/to/repo --team T_ID --user U_ID`: create instance configuration.
- `REGENT_SMOKE=1 pnpm smoke`: opt-in real-Claude verification; requires configuration
  and authentication and may incur usage charges.

There is no compilation step: Node executes TypeScript directly.

## Coding Style

Match existing ESM code: two-space indentation, single quotes, and generally no
semicolons. Include file extensions in relative imports. Use camelCase for functions
and variables, PascalCase for types/classes, and descriptive kebab-case filenames.
Prefer existing helpers and focused modules. No formatter or linter is configured;
run `git diff --check` before submitting.

## Testing Guidelines

Tests use Node assertions, temporary repositories, SQLite, fake processes, and local
HTTP servers. Name tests `test/<area>.test.mjs`; add new suites to `pnpm test`.
Cover changed behavior and failure paths, especially cancellation, deduplication,
restart recovery, permissions, and secret redaction. No numeric coverage threshold
is configured. Distinguish simulated tests from real Slack/provider verification.

## Commits & Pull Requests

Follow history: `fix:`, `refactor:`, `docs:`, or scoped prefixes such as `fix(slack):`.
Keep commits focused. PRs should describe behavior, relevant issues, tests performed,
and operational risks. Include screenshots for Slack rendering changes and update
`docs/v2.md` when delivery status changes.

## Security & State

Follow `CONTRIBUTING.md`: never extract or forward Claude credentials. Keep secrets
out of commits and logs. Preserve instance configuration, worktrees, and the existing
`log/v2.sqlite` database; its filename is not a source-layout convention.
