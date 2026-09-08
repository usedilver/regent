# Multiple repositories and project creation

Regent has no built-in organization, template, hosting provider or domain routing.
The configured default repository is an entry point, not the only project.
See [v2.md](v2.md) for the product contract and remaining implementation work.

## Create, clone or review

Use the context repository's instructions, skills, scripts, CLI or MCPs.
There is no `.regent/projects.json`, profile discovery tool or Regent provisioning
API. Git and gh follow the same runtime permissions as other shell commands.
Remote review does not require a local clone if the available tools suffice.

For a new local project, choose a distinct path in the authorized workspace and
verify it does not overwrite existing work. The repository's own tools handle
initialization, template selection, remote creation and seeding project context.
Regent does not require an initial commit, origin or deployment to select a repo.
Editing, testing and publication use repository tools; Regent has no worktree,
installation, PR or task helpers. An empty repository can be initialized directly.

Confirm ownership or paid/public actions when the request and repository rules
do not already establish authorization. Do not invent credentials or copy server
secrets. After a failed or interrupted creation, inspect local and remote state
before retrying: repository tools own reconciliation of their external effects.

## Select a repository

`regent_use_repo(repo, handoff)` selects an existing repository inside the effective
workspace. Paths are absolute or relative to that workspace, not the current cwd.
The handoff describes the human objective, decisions and unfinished work.

The switch and continuation are stored atomically. Regent ends the old process and
starts a fresh Claude session with the selected repository as cwd. Its settings,
MCP configuration and default environment files are loaded there. The old Claude
session is not resumed; conversational continuity comes from the explicit handoff.
Explicit `repos.agent_env_files` remain operator-configured shared inputs.

Other conversations keep their context. Switching is refused with queued messages
or in-flight tools; wait until those operations finish. Worktrees no longer prevent
selecting another project, and no task record controls the switch.
Selecting a submodule is not required just to edit it with the parent's context.

## Permissions and migration

In `native` mode the runtime applies its permission settings; in `bypass` it does
not. Removing Regent's git/gh denylist does not authorize an operation rejected by
the runtime. Hooks are not a filesystem sandbox. Workspace containment is enforced
for context selection, not for every arbitrary shell command.

Direct Write/Edit are checked against the authorized workspace, including symlinks,
but do not require a core-owned worktree or a task approval. Native mode does not
pre-allow repository editing tools. Concurrent sessions do not automatically get
separate checkouts: follow the repository's isolation rules and preserve other work.
Context refresh from Slack and independent room creation are the next modules.

The previous profile tools were removed. Existing manifest files are neither read
nor deleted; move any useful commands into the repository's own skills or scripts.
Old project effect records remain in SQLite for audit; Regent no longer executes
or retries them. No repository files, remote resources or sessions are deleted.
If a resumed session remembers the removed tools, it should use repo tools instead.
