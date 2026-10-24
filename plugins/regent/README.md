---
updated: 2026-10-24
---

# Regent client for Claude

This generic client delegates repository investigation and code changes to an
operator's Regent instance. It contains a manifest and a delegation skill;
project instructions, credentials and execution stay on the server.

## Package and install

Configure the instance's HTTPS endpoint, OAuth provider and access policy first.
From this repository, package the client for that endpoint:

```sh
pnpm plugin:pack --endpoint https://your-regent-host.example/mcp
```

Replace the example host with the published instance. The command generates
`dist/plugins/regent-<version>.zip` and `.zip.sha256`. Its five-file allowlist
contains the manifest, generated `.mcp.json`, skill, this guide and MIT license.
No instance environment, tokens or server implementation are included.

Install the ZIP in Claude Desktop and authenticate when prompted. Use `/regent`
or `/regent:regent`; natural-language selection depends on the host client.
Packaging does not deploy or configure the server. For local terminal clients,
the existing stdio bridge is a separate connection option.

## Own a branded distribution

Organizations maintain their branded clients in their own repositories. Copy
the public client layout and packager, update its manifest and skill, and own
its endpoint, tests, artifacts and releases there. Keep `regent_*` tool names
compatible with the server; a client name does not select a project or grant
access. The configured instance and repository context make those decisions.

Client and runtime versions are independent. Generic client releases use
`regent-client-v<manifest-version>` tags and `REGENT_PLUGIN_ENDPOINT`. A manual
workflow run accepts an endpoint and uploads an artifact without publishing a
release. Released archives must not be replaced with different contents.
