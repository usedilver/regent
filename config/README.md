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
- `limits`: concurrency, per-turn seconds (`ask`, `patch`, `task`, `project`), inactivity
  timeout (`stall_sec`) and cancellation grace period (`cancel_grace_sec`).
- `budget`: per-run and daily USD limits, applied only in `auth.mode: team`.
- `session.idle_reset_hours`: resets eligible idle non-thread sessions; not a
  history retention policy.
- `models.ask` / `patch` / `task` / `project`: optional CLI model identifiers. Null leaves
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

## Slack Images

Image attachments shared as Slack files are sent to Claude as visual input, including
earlier thread messages and image-only DMs. Initial limits: five images per turn,
3 MiB each, 10 MiB total, 8000 x 8000 pixels; PNG/JPEG/GIF/WebP only. The app needs
`files:read`. URLs pasted as text and PDF pages are not processed as images.
See [image transport](../docs/slack-images.md) and [future formats](../docs/slack-attachments-roadmap.md).

## Slack Sender Identity

Each turn uses the event sender's Slack user ID and the configured workspace ID,
not the thread starter or the owner of a connected tool. `users.info` enriches
that identity with optional name/email. Profiles are cached for five minutes;
failed lookups for thirty seconds. Enrichment waits at most two seconds and yields
to cancellation. Missing profile information does not block ordinary tasks.

The manifest requests `users:read` and `users:read.email`. For an existing Slack
app, add the email scope in OAuth & Permissions (or update the manifest), reinstall
the app into the workspace to approve it, and restart Regent. Editing the manifest
in Git alone does not grant an installed app new scopes. Email may still be absent.
No user OAuth token or additional webhook is required for this lookup.

Profiles are mutable data, not authorization or a universal cross-service identity.
Skills must resolve a unique external user mapping/email match before assigning
resources; ambiguous or missing matches require a question, never the connection
owner as a fallback. Do not publish the profile email unnecessarily.

References: [users.info](https://docs.slack.dev/reference/methods/users.info/),
[user objects](https://docs.slack.dev/reference/objects/user-object/),
[email scope](https://docs.slack.dev/reference/scopes/users.read.email/).

## Project Environment Files

The hook does not impose special path or shell-operator restrictions on `.env`
files, including `.env.local`. Reads and shell commands can access files outside
the worktree when runtime permissions allow it. General Write/Edit confinement,
including symlink escape checks, remains unchanged. Claude credential guards and
repository permission rules in native mode still apply.
This is not secret isolation between projects: in bypass mode the same OS user
can read other checkouts' env files. Use OS-level isolation for untrusted projects.

Keep runtime secrets ignored by Git, preserve unrelated keys when editing, and
never print values to Slack or commit them. These hooks are not a shell sandbox:
scripts and tools running as the same OS user can access that user's files.

## Turn Profiles

Each Slack DM root message starts an independent conversation, just like a normal
channel thread. Replies in that thread reuse its session, repository and worktree;
another root starts from the configured default unless a repo is explicitly selected.
History and attachments are scoped to the thread. Reply inside the existing thread
to continue work or stop it. Managed Regent rooms intentionally share channel-wide
context, including their threads. Moving a DM thread to a room redirects only that
source thread, not the entire DM.

Upgrading preserves old channel-wide DM records but does not reuse their sessions
for threaded conversations. Existing DM threads start fresh sessions on their next
message and recover their own Slack history; explicitly select their project when
resuming older work. Other threads' old worktrees and pending work are not deleted.

Slack no longer defaults every turn to ask. A deterministic Spanish/English router
selects project for app creation, patch for edits, task for operational requests,
and ask for questions. Short continuations inherit the previous turn's profile.
Repository handoffs preserve the profile. Rules are heuristic, not a semantic guarantee:
use `/project <request>` (a prefix in the message, not a registered Slack slash command)
to force project, or /ask, /patch, /task for the other profiles. In Slack, put the
prefix after the mention. Skills may set `intent` on `regent_use_repo`, including
the current repo, to restart under the correct configured model before building.

`models.project` and `limits.max_run_sec.project` are active settings again.
Default project timeout: 7200 seconds (two hours). The other defaults remain 600,
1800 and 3600 seconds. Set models explicitly in the instance config; public templates
leave model IDs null. If project is null, it falls back to models.task for older
instance configurations. Routing does not grant deployment/data permissions.
The `routing` event records chosen intent, model and timeout without credentials.
Changing a YAML on this machine does not update the server's ignored config.

## Removed Inactive Fields

Before upgrading an old instance, remove these keys (they had no runtime effect):
`policy`, `mcp`, `projects`, `notion`; `repos.default_base_branch`,
`repos.base_branches`, `repos.test_commands`; `slack.ops_channel`,
`slack.digest_channel`; `limits.max_run_sec.project_step`.
The schema now rejects them rather than silently suggesting they are supported.
Branches, test commands, trackers and MCP setup belong to the repository.
Omitting a supported setting uses its default, not necessarily a disabled state.
