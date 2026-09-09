# Regent: Slack Socket Mode and official Claude Code CLI.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/gh.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/gh.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/gh.list \
  && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*
RUN npm i -g pnpm@10.28.1 @anthropic-ai/claude-code
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY . .
# Mount config/regent.yaml, credentials, logs and repositories persistently.
# HTTP remains loopback-only; Slack uses outbound Socket Mode.
USER node
CMD ["node", "src/server.ts"]
