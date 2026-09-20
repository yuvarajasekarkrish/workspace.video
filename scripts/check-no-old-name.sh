#!/usr/bin/env bash
# Fails if the retired internal name ("cosmos") appears in any tracked file outside
# docs/ and the lockfile. docs/ is excluded on purpose: it names the competitor
# (cosmos.video) and keeps historical records. Run from anywhere in the repo.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

hits=$(git grep -n -i -I cosmos -- . ':!docs' ':!pnpm-lock.yaml' ':!scripts/check-no-old-name.sh' || true)
if [ -n "$hits" ]; then
  echo "Old name found outside docs/:" >&2
  echo "$hits" >&2
  exit 1
fi
echo "ok: no old name outside docs/"
