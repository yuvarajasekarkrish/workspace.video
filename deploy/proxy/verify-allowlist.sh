#!/usr/bin/env bash
# Proves, with real containers, that deploy/Caddyfile forwards ONLY /socket.io and
# /health to the realtime server and everything else to the web app.
#
# Two stand-in upstreams answer with their own name whatever path they are asked
# (tiny Caddy servers: unlike http-echo they have no special /health, and they do
# not redirect '//' paths), so the answer shows which one the proxy chose. Needs
# Docker. Every container and the network are removed on exit, pass or fail.
#
#   bash deploy/proxy/verify-allowlist.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

PREFIX="wv-proxy-check-$$"
NET="$PREFIX-net"
PORT="${PROXY_CHECK_PORT:-18099}"
ROOT="$(pwd -W 2>/dev/null || pwd)"

cleanup() {
  docker rm -f "$PREFIX-web" "$PREFIX-realtime" "$PREFIX-caddy" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$NET" >/dev/null
stand_in() { # stand_in <name> <alias> <port> <text>
  docker run -d --name "$PREFIX-$1" --network "$NET" --network-alias "$2" caddy:2-alpine     sh -c "printf ':$3 {
	respond \"$4\"
}
' > /tmp/Caddyfile && caddy run --config /tmp/Caddyfile --adapter caddyfile" >/dev/null
}
stand_in web web 3000 WEB
stand_in realtime realtime 4001 REALTIME

# The Caddyfile must be valid before it is used.
MSYS_NO_PATHCONV=1 docker run --rm -e APP_ADDRESS=:8080 -v "$ROOT/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine \
  caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || { echo "FAIL: Caddyfile is not valid" >&2; exit 1; }

MSYS_NO_PATHCONV=1 docker run -d --name "$PREFIX-caddy" --network "$NET" -p "$PORT:8080" -e APP_ADDRESS=:8080 \
  -v "$ROOT/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine >/dev/null

for _ in $(seq 1 30); do
  curl -s -o /dev/null "http://localhost:$PORT/" && break
  sleep 1
done

failures=0
expect() { # expect <REALTIME|WEB> <path> [curl args...]
  local want=$1 path=$2; shift 2
  local got
  got=$(curl -s --path-as-is "$@" "http://localhost:$PORT$path" | tr -d '\r\n')
  if [ "$got" = "$want" ]; then
    printf 'ok    %-9s %s\n' "$want" "$path"
  else
    printf 'FAIL  wanted %s, got "%s"  for %s\n' "$want" "$got" "$path" >&2
    failures=$((failures + 1))
  fi
}

# Forwarded to the realtime server
expect REALTIME /socket.io/
expect REALTIME '/socket.io/?EIO=4&transport=polling'
expect REALTIME /health

# Never forwarded: the /internal pages, in every spelling, only ever reach the web app
expect WEB /internal/metrics
expect WEB /internal/metrics -H 'authorization: Bearer anything'
expect WEB /internal/resolve-room/room1
expect WEB /internal/load-harness/provision -X POST
expect WEB //internal/metrics
expect WEB /%69nternal/metrics
expect WEB /INTERNAL/metrics
expect WEB /internal/
expect WEB /healthz
expect WEB /api/auth/session
expect WEB /

if [ "$failures" -ne 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all proxy allow-list checks passed"
