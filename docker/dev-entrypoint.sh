#!/bin/sh
# Keeps the node_modules volume in step with the lockfile before starting. A no-op when current.
# A fresh volume may carry the host's own node_modules (the bind mount is copied into it the
# first time); CI=true lets pnpm replace that layout without a prompt. Scoped to the install.
set -e
cd /app
CI=true pnpm install --frozen-lockfile --prefer-offline --loglevel warn
exec "$@"
