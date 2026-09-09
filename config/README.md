# Instance Configuration

Create `regent.yaml` with `pnpm regent setup --repo /path/to/repos/project --team T_ID --user U_ID`.
See [the example](regent.example.yaml) for optional settings.

`repos.path` is the authorized workspace; `repos.default_repo` is relative to it
(and to `workspace_root` if configured). The repository provides rules, skills,
MCPs and its own environment. Existing conversations retain their selected repo.

Only this README and `regent.example.yaml` are tracked in this directory.
The runtime reads `regent.yaml`, never the example. Server secrets belong in the
root `.env`. The retired v1 `workflow.json` and `process.md` are not loaded.

## Active Settings

- `auth.mode` and `slack.workspace_team_id` / `allowed_users`: identity and access.
  Indie warns, but does not stop, with zero or multiple authorized users.
  An empty list admits verified active workspace users, not bots. This warning
  does not establish provider permission; prefer team/API for shared usage.
- `permission_mode`: make this explicit. Default `bypass` skips native permission
  rules; `native` respects them. Regent hooks are not a shell sandbox.
- `repos.path` / `default_repo`: workspace and initial context. Optional
  `workspace_root` narrows the workspace to a subdirectory.
- `repos.agent_env_files`: optional explicit environment files. Empty/omitted
  loads the selected repository's root `.env`; it does not disable environment loading.
- `repos.readonly_mcp`: optional additional hook restrictions; not a replacement
  for read-only credentials on the data source.
- `slack.progress_mode`: `auto` (default) for task cards, `plain` for simple text.
- `limits`: concurrency, per-turn seconds (`ask`, `patch`, `task`), inactivity
  timeout (`stall_sec`) and cancellation grace period (`cancel_grace_sec`).
- `budget`: per-run and daily USD limits, applied only in `auth.mode: team`.
- `session.idle_reset_hours`: resets eligible idle non-thread sessions; not a
  history retention policy.
- `models.ask` / `patch` / `task`: optional CLI model identifiers. Null leaves
  selection to Claude Code. `name` labels the server, not the Slack app profile.

## Removed Inactive Fields

Before upgrading an old instance, remove these keys (they had no runtime effect):
`policy`, `mcp`, `projects`, `notion`; `repos.default_base_branch`,
`repos.base_branches`, `repos.test_commands`; `slack.ops_channel`,
`slack.digest_channel`; `limits.max_run_sec.project_step`; `models.project`.
The schema now rejects them rather than silently suggesting they are supported.
Branches, test commands, trackers and MCP setup belong to the repository.
Omitting a supported setting uses its default, not necessarily a disabled state.
