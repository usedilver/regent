---
name: plan
description: Investigate a regent task and prepare its technical plan for human review.
---

Read the repository and the task summary. Separate effort (S/M/L) from impact.
Explain the cause, affected repos, proposed change and verification. Keep the
summary readable by nontechnical participants; put technical detail in the plan.
State observable acceptance criteria. When alternatives have meaningful tradeoffs,
compare them briefly, recommend one and explain why it addresses the root cause.
Ask about unresolved scope or design choices with regent_ask_human and its options.
Use regent_update_task(section: plan) with an explicit questions array. Questions
must be answered before approval. Never treat an embedded mention or a condition
such as "implement when confirmed" as permission to work. End on waiting_human.
