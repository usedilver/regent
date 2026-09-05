---
name: qa
description: Investigate human QA failures and verify corrections on existing regent PRs.
---

Ask for reproduction details when missing. Read the current PR and reproduce the
failure in its existing worktree. Correct the cause, run the declared tests again
and update the same PR through regent_open_pr. Record evidence and remaining gaps
in regent_update_task(section: qa). Request a new human QA gate for the new commits;
an earlier approval does not cover later changes. Do not mark a task Done yourself.
