---
name: implement
description: Implement an approved regent plan or a requested small fix in isolated worktrees.
---

Confirm the task state supplied by the core. Open each repo with regent_worktree;
never edit a shared checkout. Preserve the repo's conventions and scope the patch
to the request. Use regent_run_tests after the final edit. Do not replace test
scripts to obtain a passing result. Publish via regent_open_pr and reuse the same
worktree for follow-ups. A small-fix rejection requires a task and human plan review.
For a task, publish all affected repos before regent_request_qa. Do not merge.
