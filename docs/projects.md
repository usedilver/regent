# Multiple repositories and project creation

SUPERSEDED DESIGN: the profile manifest and provisioning tools described below
still exist in code but are scheduled for removal. They are not required by the
agreed product contract. See [v2.md](v2.md); do not adopt this manifest for new setups.

Regent has no built-in organization, template, hosting provider or domain routing.
The configured default repository is an entry point, not the only project.

## Select a repository

`regent_use_repo(repo, handoff)` selects an existing repository inside the effective
workspace. Paths are absolute or relative to that workspace, not the current cwd.
The handoff describes the human objective, decisions and unfinished work.

The switch and continuation are stored atomically. Regent ends the old process and
starts a fresh Claude session with the selected repository as cwd. Its settings,
MCP configuration and default environment files are loaded there. The old Claude
session is not resumed; conversational continuity comes from the explicit handoff.
Explicit `repos.agent_env_files` remain operator-configured shared inputs.

Other conversations keep their context. Switching is refused with queued messages,
in-flight tools or active worktrees; use another thread for an unrelated project
in that case. A task record, if present, is preserved, including its approval state.
Selecting a submodule is not required just to edit it with the parent's context.

## Repository-owned profiles

The context repository can declare `.regent/projects.json`:

```json
{
  "profiles": {
    "internal-tool": {
      "command": ["node", "scripts/provision-project.mjs"]
    }
  }
}
```

`regent_project_profiles` lists these profiles. `regent_create_project` accepts:

```json
{
  "profile": "internal-tool",
  "destination": "projects/alex-renewals",
  "input": { "name": "alex-renewals" }
}
```

The parent directory must already exist inside the workspace and outside any
repository. Regent creates an empty target directory, then executes the profile's
argv without an implicit shell, from the source repository. Inputs are passed as:

- `REGENT_PROJECT_DIR`: canonical absolute destination.
- `REGENT_PROJECT_INPUT`: JSON object of string values, treated as data.
- The same filtered environment prepared for the source agent, not Regent secrets.

The script owns provider authentication, template choice and remote creation.
On success it must leave a git repository with an initial commit, an `origin`
remote and a corresponding remote-tracking branch for the checked-out branch.
It must seed the project's own context and install only necessary credentials.
The destination is already present: scripts must accept an empty directory.

The result returns the repository path. Call `regent_use_repo` next; subsequent
editing uses Regent worktrees and the existing PR workflow. Repository creation
is provider-neutral; existing PR publication remains GitHub/gh-based.

## Trust and recovery

Profiles are executable operator-trusted code, not sandboxed. Do not put credentials
in the manifest, command arguments or tool input. Define resource limits and access
policy in the profile; ask for confirmation before paid resources or public exposure.
Regent checks an existing task's plan gate, but does not infer provider-specific costs.

A destination has one persisted creation effect. Completed calls return the same
result. Failed or interrupted calls are not automatically repeated, even if a
partial checkout exists: a remote resource may already exist. Inspect and reconcile
the recorded effect before retrying; there is no automatic provider reconciliation
or operator recovery command in this first implementation. Files are not deleted.

No profile is bundled or enabled for Talently. Adapting Talenter, moving its secrets,
and reviewing its deployment/access policy are separate work in that repository.
