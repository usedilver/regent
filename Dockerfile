# backlog-bridge — modo headless (sin herdr/tmux; agentes con log)
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/gh.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/gh.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/gh.list \
  && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*
RUN npm i -g pnpm @anthropic-ai/claude-code
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY . .
# .env, workflow.json y credenciales de claude/gh se montan como volúmenes
EXPOSE 8787
CMD ["node", "src/server.ts"]
