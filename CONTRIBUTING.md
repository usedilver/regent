# Contributing to Regent

Regent is a project-agnostic conversational client for the official Claude Code CLI.
Read [ARCHITECTURE.md](ARCHITECTURE.md) to locate the component you want to change.
Contributors do not need access to an operator's production services or internal tracker.

## Local checks

Use the Node version in `.nvmrc`, pnpm pinned in `package.json` and Python 3 for plugin packaging tests.

```sh
nvm use
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` is the main CI job: formatting, strict TypeScript checking and automated tests.
It uses temporary repositories, SQLite, simulated Claude processes and local HTTP servers;
no Slack, Google, Anthropic or production credentials are required. `pnpm format` applies
formatting. `pnpm typecheck` and `pnpm test` run individual parts.

Suites named `test/**/*.test.mjs` are discovered automatically and run sequentially in isolated
processes. Add regression cases for changed behavior without adding filenames to package scripts.
Keep reusable fixtures under `test/fixtures/`; use `node:test` for new cases. Real-Claude and Slack
checks live in `test/smoke/` and require explicit opt-in and the operator's own authentication.
`REGENT_SMOKE=1 node test/smoke/on-demand-worktrees.mjs` checks query → edit → query with the
unmodified CLI, a temporary repository and a synthetic project MCP. It incurs normal provider
usage, keeps source files unchanged and removes its temporary files; it never inspects or copies
authentication files. Simulated tests are the default in CI.
Set `REGENT_USER_ID` for local CLI attribution if the instance has no single allowed Slack user.
A simulated test does not establish production or provider compatibility.

When changing Docker or required runtime assets, also run:

```sh
pnpm check:image
```

This additional CI job requires Docker, builds the deployable image and verifies its default
prompt resources and installed official CLI. It does not authenticate or execute an agent.

## Focused changes and review

Describe the problem and resulting behavior in the PR. Include reproduction/verification,
compatibility implications and concrete limitations. Keep formatting-only moves separate from
behavior changes when practical. Preserve public `regent_*` tool names, OAuth/session contracts,
instance configuration, existing worktrees and `log/v2.sqlite`. Add compatibility aliases or
migrations before changing public contracts or persisted state.

The PR template records verification; CODEOWNERS requests maintainer review. Public PRs are enough
for contribution and review; maintainers may link their internal planning separately. Review
agent-generated changes yourself before submitting them.

Use existing ESM conventions and Conventional Commits in English. Keep instructions stable and
general; adding a feature does not require appending an inventory to AGENTS.md. Explain a changed
shared contract in the architecture/configuration guide instead of duplicating implementation.

## Authentication and secrets

Use the unmodified official `claude` binary. The operator configures their own local login for
one human (`indie`), or `ANTHROPIC_API_KEY` for team execution. Contributions must not read, copy,
store or forward Claude credentials, including `~/.claude/.credentials.json`, provider session
tokens or third-party OAuth tokens. Do not add a Claude login inside Regent or call provider APIs
with subscription credentials outside the official binary. Repository trust is separate from auth.

Never include real tokens or sensitive transcripts in fixtures, issues, PRs or plugins. Application
preview authentication remains the application's responsibility. Report security issues privately
to the maintainer rather than publishing credentials or exploit transcripts.

## Versions and distributable plugins

Runtime package, internal executor protocol, external MCP server and client plugin versions identify
different contracts; they need not match. Bump the version of the contract being changed and preserve
compatibility. A server refactor does not require reinstalling an unchanged client plugin.

The client packager produces `dist/plugins/<name>-<version>.zip` and `.zip.sha256` from an explicit
five-file allowlist. It requires a literal public HTTPS MCP endpoint and bundles no instance config,
server implementation or credentials. Verify the generated endpoint before distribution.

Generic client releases use `regent-client-v<client-manifest-version>` tags. The release workflow reads
`REGENT_PLUGIN_ENDPOINT` from repository variables, runs `pnpm check`, validates the tag against
the client manifest and uploads the ZIP/checksum to the GitHub release. Set that non-secret variable
before tagging. The manual workflow accepts an explicit endpoint and uploads an Actions artifact
without publishing a release; this supports independent Regent instances.

Branded clients, their packaging tests and their releases belong in the organization's own repository.
See the [client guide](plugins/regent/README.md) for packaging and installation. The root
runtime version and client release tag are independent; do not overwrite an existing client release
with a different endpoint or archive.
