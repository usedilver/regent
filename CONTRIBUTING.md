# Contributing to regent

Use the unmodified `claude` binary as the execution engine. The operator configures
their own local login for one human (`indie`), or `ANTHROPIC_API_KEY` for a team.

Contributions must not read, copy, store or forward Anthropic credentials, including
`~/.claude/.credentials.json`, third-party OAuth tokens or session tokens. Do not add
a Claude login inside regent, modify the Claude binary, or call Anthropic APIs with
subscription credentials outside that binary. Do not commit secrets or transcripts
containing them. Configuration of repo trust is separate from authentication.

Name the product and integrations regent. Consult the upstream branding terms before
introducing provider branding. Authentication requirements remain subject to the
operator's current provider agreement.

Run `pnpm test` and `pnpm test:v2` for changes to execution or adapters. Tests use
temporary repositories, SQLite databases, a fake Claude process and local HTTP
servers. They do not require provider tokens. The real-Claude smoke is opt-in.

Keep delivery status in `docs/v2.md` accurate: a fake integration test does not mark
a production smoke or a week of real usage complete.
