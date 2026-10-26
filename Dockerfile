# Regent: Slack Socket Mode and official Claude Code CLI.
# Stages: `base` carries the runtime tools, `dev` adds dev dependencies and runs under
# `node --watch` with the repository bind-mounted, `production` (the default target) ships the
# source with production dependencies only.
FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates python3 python3-venv python3-pip \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/gh.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/gh.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/gh.list \
  && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*
ARG CLAUDE_CODE_VERSION=2.1.284
RUN npm i -g pnpm@10.28.1 @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}
WORKDIR /app

# Development (see compose.yaml). node_modules lives in a volume seeded from this image; the
# entrypoint keeps it in step with the lockfile. Everything runs as `node`, so the volume and the
# bind-mounted repository stay writable.
FROM base AS dev
ENV NODE_ENV=development
COPY docker/dev-entrypoint.sh /usr/local/bin/dev-entrypoint
RUN chmod +x /usr/local/bin/dev-entrypoint && chown node:node /app
USER node
COPY --chown=node:node package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
ENTRYPOINT ["dev-entrypoint"]
CMD ["pnpm", "dev"]

FROM base AS production
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY . .
# Mount config/regent.yaml, credentials, logs and repositories persistently.
# HTTP remains loopback-only; Slack uses outbound Socket Mode.
USER node
CMD ["node", "src/server.ts"]
