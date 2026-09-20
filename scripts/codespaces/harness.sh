#!/usr/bin/env bash
# Codespace B: load generator only. Reaches codespace A on port 4001 and
# nothing else (no Postgres, no Redis).
# Usage: export REALTIME_JWT_SECRET=<same value as codespace A>
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

if [ -z "${REALTIME_JWT_SECRET:-}" ] && [ -n "${AUTH_SECRET:-}" ]; then
  echo "AUTH_SECRET is no longer used here. Set REALTIME_JWT_SECRET instead (same value as codespace A)." >&2
fi
: "${REALTIME_JWT_SECRET:?Set REALTIME_JWT_SECRET first (same value as codespace A)}"
cd "$(dirname "$0")/../.."

# Phase 12: this file used to be deleted on every exit. It's the single
# most direct evidence available for what `gh codespace ports forward`
# itself did during a run — if it reconnects, rotates, or errors partway
# through, this is where that would show up. Keep it in a stable location
# (not a throwaway mktemp) and print it after the run, pass or fail.
FORWARD_LOG="apps/realtime/load-results/${4}-forward.log"
mkdir -p apps/realtime/load-results
: >"$FORWARD_LOG"

# Phase 13: refuse to run against a forward this script did not start.
# A previous run's `gh codespace ports forward` can outlive it (an aborted
# run never reaches the EXIT trap that kills it), and the old code would
# then silently adopt that stale tunnel: our own forward failed to bind with
# "address already in use", the health check below passed against the
# leftover one anyway, and a whole 60s measurement ran through a tunnel of
# unknown age and condition. We only ever kill the PID we started ourselves
# (see the trap), so a pre-existing listener is reported, not killed — it
# may belong to another session and is not ours to terminate.
if curl -sf http://localhost:4001/health >/dev/null 2>&1; then
  echo "ABORT: something is already listening on localhost:4001 before this script started a forward." >&2
  echo "That is almost certainly a leaked 'gh codespace ports forward' from an earlier run. Results measured" >&2
  echo "through it cannot be trusted, so this script will not adopt it. Find and stop it, e.g.:" >&2
  echo "    pgrep -af 'gh codespace ports forward'" >&2
  echo "    kill <pid>" >&2
  exit 1
fi

FORWARD_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
gh codespace ports forward 4001:4001 -c "$SERVER_CODESPACE" >"$FORWARD_LOG" 2>&1 &
FORWARD_PID=$!
trap 'kill "$FORWARD_PID" 2>/dev/null || true' EXIT

# Confirm OUR forward actually bound before trusting anything downstream of
# it. Without this, a bind failure falls through into the health-check wait
# below, which is exactly how the stale tunnel got adopted last time — this
# loop fails fast on either a bind error or the process dying, instead of
# just waiting out the full 60-attempt timeout and reporting a generic
# "not reachable".
for attempt in $(seq 1 60); do
  if grep -qiE 'address already in use|failed to listen' "$FORWARD_LOG"; then
    echo "ABORT: our own port forward failed to bind. Forward log:" >&2
    cat "$FORWARD_LOG" >&2
    exit 1
  fi
  if ! kill -0 "$FORWARD_PID" 2>/dev/null; then
    echo "ABORT: the port-forward process exited immediately. Forward log:" >&2
    cat "$FORWARD_LOG" >&2
    exit 1
  fi
  if curl -sf http://localhost:4001/health >/dev/null 2>&1; then break; fi
  if [ "$attempt" -eq 60 ]; then
    echo "Realtime server not reachable through the port forward. Forward log:" >&2
    cat "$FORWARD_LOG" >&2
    echo "If this is a permissions error, run: gh auth refresh -h github.com -s codespace" >&2
    exit 1
  fi
  sleep 2
done

echo "Harness CPU: $(nproc) cores. Server reachable via port forward."
echo "Port forward started at: $FORWARD_STARTED_AT"

# Phase 12: a pure-transport canary, no Socket.IO and no app traffic —
# opens raw TCP connections through the SAME forwarded port and just holds
# them, so a mass disconnect here can only be explained by the relay itself,
# never by anything the realtime server or the load it generates is doing.
# Runs BEFORE the loaded harness so its longer hold window (120s) isn't
# competing with the loaded run for the tunnel.
echo
echo "--- tunnel canary (raw TCP, no app traffic, ~120s) ---"
# Phase 12 bug #2: `npx tsx apps/realtime/src/scripts/tunnelCanary.ts` failed
# in the Codespace — npx there resolves to a pnpm-backed shim that runs with
# cwd set to the workspace package, so the repo-root-relative path doubled
# into apps/realtime/apps/realtime/... (ERR_MODULE_NOT_FOUND). Going through
# a package script instead, exactly like load-harness two commands below,
# resolves deterministically regardless of npx's cwd behavior.
CANARY_STATUS=0
REALTIME_URL=http://localhost:4001 \
  pnpm --filter @cosmos/realtime run tunnel-canary || CANARY_STATUS=$?
echo "--- end tunnel canary (exit $CANARY_STATUS) ---"
echo

env -u DATABASE_URL -u REDIS_URL \
  REALTIME_URL=http://localhost:4001 \
  LOAD_HARNESS_LABEL="$LABEL" \
  LOAD_HARNESS_ONLY_N="$N" \
  LOAD_HARNESS_ONLY_SCENARIO=spread \
  LOAD_HARNESS_WINDOW_SEC="$WINDOW_SEC" \
  pnpm --filter @cosmos/realtime run load-harness || STATUS=$?

ls -1 apps/realtime/load-results/"$LABEL"-"$N"-*.json 2>/dev/null || true

echo
echo "--- gh codespace ports forward log ($FORWARD_LOG) ---"
cat "$FORWARD_LOG"
echo "--- end forward log ---"

exit "${STATUS:-0}"
