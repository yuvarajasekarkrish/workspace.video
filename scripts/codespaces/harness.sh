#!/usr/bin/env bash
# Codespace B: load generator only. Reaches codespace A on port 4001 and
# nothing else (no Postgres, no Redis).
# Usage: export AUTH_SECRET=<same value as codespace A>
#        bash scripts/codespaces/harness.sh <server-codespace-name> <N> <windowSec> <label>
# Example sequence: 50 60 · 100 60 · 200 600 (run 1) · 200 600 (run 2, after restarting server.sh)
set -euo pipefail

if [ $# -lt 4 ]; then
  echo "usage: harness.sh <server-codespace-name> <N> <windowSec> <label>" >&2
  exit 2
fi
SERVER_CODESPACE=$1
N=$2
WINDOW_SEC=$3
LABEL=$4

: "${AUTH_SECRET:?Set AUTH_SECRET first (same value as codespace A)}"
cd "$(dirname "$0")/../.."

FORWARD_LOG=$(mktemp)
gh codespace ports forward 4001:4001 -c "$SERVER_CODESPACE" >"$FORWARD_LOG" 2>&1 &
FORWARD_PID=$!
trap 'kill "$FORWARD_PID" 2>/dev/null || true; rm -f "$FORWARD_LOG"' EXIT

for attempt in $(seq 1 60); do
  if curl -sf http://localhost:4001/health >/dev/null; then break; fi
  if [ "$attempt" -eq 60 ]; then
    echo "Realtime server not reachable through the port forward. Forward log:" >&2
    cat "$FORWARD_LOG" >&2
    echo "If this is a permissions error, run: gh auth refresh -h github.com -s codespace" >&2
    exit 1
  fi
  sleep 2
done

echo "Harness CPU: $(nproc) cores. Server reachable via port forward."

env -u DATABASE_URL -u REDIS_URL \
  REALTIME_URL=http://localhost:4001 \
  LOAD_HARNESS_LABEL="$LABEL" \
  LOAD_HARNESS_ONLY_N="$N" \
  LOAD_HARNESS_ONLY_SCENARIO=spread \
  LOAD_HARNESS_WINDOW_SEC="$WINDOW_SEC" \
  pnpm --filter @cosmos/realtime run load-harness || STATUS=$?

ls -1 apps/realtime/load-results/"$LABEL"-"$N"-*.json 2>/dev/null || true
exit "${STATUS:-0}"
