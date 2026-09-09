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

## Shared Agent Credentials (Optional)

A dedicated, trusted instance may supply provider credentials through its service
environment. Regent does not require or interpret any provider-specific keys.
All agent processes inherit them, including repository scripts and MCP subprocesses;
do not use this configuration to execute untrusted repositories. Worktrees and
permission hooks do not isolate credentials from code running as the same OS user.

For a systemd user service, keep a private file outside all repositories, for example
`~/.config/regent/agent-shared.env` (directory mode `700`, file mode `600`). Put
only intentionally shared credentials there, using `KEY=value` entries. Add a
drop-in with `systemctl --user edit regent.service`:

```ini
[Service]
EnvironmentFile=%h/.config/regent/agent-shared.env
```

Then run `systemctl --user daemon-reload` and `systemctl --user restart regent`.
Restart after credential rotation too; existing processes retain their environment.
For a system service use an absolute path readable by the service account instead.
Never commit this file or copy its administrative tokens into app runtime env files.

Leave `repos.agent_env_files` empty to keep loading each selected repo's `.env`.
Repository values override shared values. Keys declared in Regent's root `.env`
are removed unless supplied by the repo, so do not also declare shared keys there.
`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and `SLACK_SIGNING_SECRET` are reserved for
Regent and always removed from agent environments, regardless of their source.
The operator's `ANTHROPIC_API_KEY` remains available for Claude authentication.

Use least-privilege credentials limited at the provider to test resources. Selecting
a team or project in a CLI does not restrict the token's permissions. Validate
authentication with a clean CLI configuration and read-only commands before removing
an existing login; record CLI versions, never token values. No production deploy or
resource creation is necessary for this check.

## Removed Inactive Fields

Before upgrading an old instance, remove these keys (they had no runtime effect):
`policy`, `mcp`, `projects`, `notion`; `repos.default_base_branch`,
`repos.base_branches`, `repos.test_commands`; `slack.ops_channel`,
`slack.digest_channel`; `limits.max_run_sec.project_step`; `models.project`.
The schema now rejects them rather than silently suggesting they are supported.
Branches, test commands, trackers and MCP setup belong to the repository.
Omitting a supported setting uses its default, not necessarily a disabled state.
