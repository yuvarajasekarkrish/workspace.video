#!/usr/bin/env bash
# Codespace A: Postgres + Redis (local only) and the realtime server on :4001.
# Usage: export AUTH_SECRET=<same value as codespace B>; bash scripts/codespaces/server.sh
# Keep port 4001 PRIVATE in the Codespaces Ports panel; codespace B reaches it
# through an authenticated `gh codespace ports forward`.
set -euo pipefail
cd "$(dirname "$0")/../.."

: "${AUTH_SECRET:?Set AUTH_SECRET first (use the same value in codespace B), e.g. export AUTH_SECRET=\$(openssl rand -hex 32)}"
export DATABASE_URL="${DATABASE_URL:-postgresql://cosmos:cosmos@localhost:5432/cosmos}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"

wait_for() {
  local what=$1; shift
  for _ in $(seq 1 60); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  echo "Timed out waiting for $what" >&2
  exit 1
}

docker compose up -d postgres redis
wait_for "Postgres" docker compose exec -T postgres pg_isready -U cosmos
wait_for "Redis" docker compose exec -T redis redis-cli ping

# Explicit, not relying on devcontainer.json's postCreateCommand having run
# (or run against the right schema) — generate is idempotent and cheap, so
# always regenerating here makes this script self-sufficient on any codespace.
pnpm --filter @cosmos/db run generate
pnpm --filter @cosmos/db exec prisma migrate deploy
pnpm --filter @cosmos/realtime run build

echo
echo "Server codespace name (pass to harness.sh): ${CODESPACE_NAME:-unknown, run 'gh codespace list'}"
echo "CPU: $(nproc) cores, memory: $(free -g | awk '/Mem:/ {print $2}') GB"
echo

cd apps/realtime
export NODE_ENV=development LOAD_HARNESS_ENABLED=1 PORT=4001
exec npx tsx dist/server.js
