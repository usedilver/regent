# Instance Configuration

Create `regent.yaml` with `pnpm regent setup --repo /path/to/repos/project --team T_ID --user U_ID`.
See [the example](../regent.example.yaml) for optional settings.

`repos.path` is the authorized workspace; `repos.default_repo` is relative to it
(and to `workspace_root` if configured). The repository provides rules, skills,
MCPs and its own environment. Existing conversations retain their selected repo.

This directory is ignored except for this README. Server secrets belong in the
root `.env`. The retired v1 `workflow.json` and `process.md` are not loaded.
