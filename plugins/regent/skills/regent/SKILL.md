---
name: regent
description: Delegate repository investigation and code changes to a connected Regent instance. Use when the user asks to use Regent or work in the repositories available on that server.
---

# Regent

Regent executes work with the target repository's instructions, skills and MCPs.
The chat client supplies the request and follows the same conversation; it does
not need the executor's local files or database connections.

## Find the project and delegate

Call `regent_context` on the Regent connector. Preserve an application name, URL
or repository supplied by the user; the server default does not replace an
explicit destination. Clarify only a genuine project ambiguity. If the context
already answers a simple question, respond without starting a run.

Call `regent_start` with the original request, its business context, the selected
repository when applicable and a new UUID in `request_id`. Reuse that UUID only
to retry the same submission. Delegate the complete request without assigning workflow
stages; the server-side agent uses conversation and repository instructions to choose the
necessary work. Omit intent for ordinary requests. Use ask only when explicitly selecting
enforced read-only execution. Preserve the user's scope for edits, checks, PRs and deployment.

The executor checks its own connections. Missing tools in this chat do not prove
that the server cannot query data or edit the project. Do not substitute another
data source or sample results without evidence and the user's agreement.

## Follow the conversation

Use `regent_get_run` with its default wait of up to 20 seconds rather than polling
immediately. Follow `latest_run` when a context switch continues the work. Stop
polling when the run finishes or needs a human answer. Preserve `conversation_id`
for related follow-ups; send the answer or next request with `regent_continue` and
a new UUID per message. `regent_cancel` pauses the conversation and preserves its
code and queue when the user asks to stop.

Keep progress in this chat. Do not create scheduled tasks or reminders to check
the job unless the user explicitly requests a later notification. A brief query
usually needs only its result; longer work needs meaningful updates or blockers,
not repeated status messages or internal tool activity.

Open `regent_show_progress` only when the user requests a visual panel, once per
conversation. Reuse the panel instead of creating cards on each status call. If
the client interrupts the turn, retain the IDs and explain how to resume.

Project instructions own preview requirements and collaboration policy. A running process
is not a verified application; preserve verification limits rather than claiming success
from an HTTP response or login page.

Report the confirmed result, where to review changes, validation and remaining
limitations in proportion to the request. Do not repeat the executor's full
technical report when a short answer resolves the user's question.
