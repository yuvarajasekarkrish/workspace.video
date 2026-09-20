#!/usr/bin/env bash
# Deploys one tested build to one environment, and goes back if it is wrong.
#
#   deploy.sh <staging|production> <image-tag>              deploy
#   deploy.sh <staging|production> <previous-tag> --rollback   go back (no backup, no migration)
#
# The image tag is a commit id: CI builds an image per commit, so the exact build
# that passed the tests is what runs. Mutable tags (latest, master) are refused.
#
# Order, each step stopping the whole run if it fails:
#   preflight -> backup -> pull -> migrate -> restart -> health -> record
# The database is backed up BEFORE every migration. Migrations must stay backward
# compatible for one version, so rolling back is redeploying the previous tag.
#
# Needs in the environment:
#   REGISTRY      where the images live, e.g. registry.example.com/workspace-video
#   DATABASE_URL  the database to back up (the password is never printed)
#   APP_ADDRESS   the public address to health-check, e.g. www.workspace.video
#   DEPLOY_DIR    a folder holding docker-compose.prod.yml and .env on the server
# Optional: BACKUP_DIR (default $DEPLOY_DIR/backups), PREVIOUS_TAG (default: the
# tag recorded by the last deploy), CONFIRM=production (required for production),
# DRY_RUN=1 (print the steps and run nothing).

set -euo pipefail

ENVIRONMENT="${1:-}"
TAG="${2:-}"
ROLLBACK=0
[ "${3:-}" = "--rollback" ] && ROLLBACK=1
DRY_RUN="${DRY_RUN:-0}"

fail() {
  echo "deploy: $*" >&2
  exit 1
}

case "$ENVIRONMENT" in
  staging | production) ;;
  *) fail "the first argument must be staging or production" ;;
esac
[[ "$TAG" =~ ^[0-9a-f]{7,40}$ ]] || fail "the image tag must be a commit id (7 to 40 hex characters), not '${TAG}'"
if [ "$ENVIRONMENT" = production ] && [ "${CONFIRM:-}" != production ]; then
  fail "deploying to production needs CONFIRM=production"
fi
for name in REGISTRY DATABASE_URL APP_ADDRESS DEPLOY_DIR; do
  [ -n "${!name:-}" ] || fail "$name is not set"
done

BACKUP_DIR="${BACKUP_DIR:-$DEPLOY_DIR/backups}"
PREVIOUS_TAG="${PREVIOUS_TAG:-$(cat "$DEPLOY_DIR/.current-tag" 2>/dev/null || true)}"
COMPOSE=(docker compose -f "$DEPLOY_DIR/docker-compose.prod.yml" --env-file "$DEPLOY_DIR/.env")
export IMAGE_TAG="$TAG" REGISTRY

CURRENT_STEP=""
on_exit() {
  local status=$?
  if [ "$status" -ne 0 ] && [ -n "$CURRENT_STEP" ]; then
    echo "deploy: FAILED during '$CURRENT_STEP'." >&2
    case "$CURRENT_STEP" in
      restart | health | record)
        if [ -n "$PREVIOUS_TAG" ] && [ "$ROLLBACK" = 0 ]; then
          echo "deploy: the new version may be running. To go back: DEPLOY_DIR=... $0 $ENVIRONMENT $PREVIOUS_TAG --rollback" >&2
        fi
        ;;
    esac
  fi
}
trap on_exit EXIT

# run_step <name> <what it does> <command...>
run_step() {
  local name=$1 what=$2
  shift 2
  CURRENT_STEP=$name
  echo "STEP $name: $what"
  if [ "$DRY_RUN" = 1 ]; then
    if [ "${DRY_RUN_FAIL_AT:-}" = "$name" ]; then
      echo "deploy: step '$name' failed (simulated)" >&2
      return 1
    fi
    return 0
  fi
  "$@"
}

preflight() {
  command -v docker >/dev/null || fail "docker is not installed"
  docker compose version >/dev/null || fail "docker compose is not available"
  [ -f "$DEPLOY_DIR/docker-compose.prod.yml" ] || fail "missing $DEPLOY_DIR/docker-compose.prod.yml"
  [ -f "$DEPLOY_DIR/.env" ] || fail "missing $DEPLOY_DIR/.env"
  if [ "$ROLLBACK" = 0 ]; then command -v pg_dump >/dev/null || fail "pg_dump is not installed (needed for the pre-migration backup)"; fi
}

backup() {
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  local file="$BACKUP_DIR/pre-$TAG-$(date -u +%Y%m%dT%H%M%SZ).dump"
  # PGDATABASE accepts a connection URI, so the password is not on the command line.
  PGDATABASE="$DATABASE_URL" pg_dump --format=custom --file "$file"
  [ -s "$file" ] || fail "the backup file is empty: $file"
  echo "backup written: $file"
}

pull() { "${COMPOSE[@]}" pull web realtime; }
migrate() { "${COMPOSE[@]}" run --rm migrate; }
restart() { "${COMPOSE[@]}" up -d --no-build --remove-orphans web realtime caddy; }

health() {
  local attempt
  for attempt in $(seq 1 30); do
    if curl -fsS "https://$APP_ADDRESS/health" >/dev/null 2>&1 &&
      [ "$(curl -s -o /dev/null -w '%{http_code}' "https://$APP_ADDRESS/api/auth/session")" = 401 ]; then
      echo "healthy after $attempt check(s)"
      return 0
    fi
    sleep 2
  done
  return 1
}

record() {
  echo "$TAG" >"$DEPLOY_DIR/.current-tag"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $ENVIRONMENT deployed=$TAG previous=${PREVIOUS_TAG:-none} mode=$([ "$ROLLBACK" = 1 ] && echo rollback || echo deploy)" >>"$DEPLOY_DIR/deploy.log"
}

echo "deploy: $ENVIRONMENT <- $TAG (previous: ${PREVIOUS_TAG:-none}; roll back with: $0 $ENVIRONMENT ${PREVIOUS_TAG:-<previous-tag>} --rollback)"

run_step preflight "check the tools and files this needs" preflight
if [ "$ROLLBACK" = 0 ]; then
  run_step backup "back up the database before any migration" backup
fi
run_step pull "pull $REGISTRY/workspace-video-web:$TAG and $REGISTRY/workspace-video-realtime:$TAG" pull
if [ "$ROLLBACK" = 0 ]; then
  run_step migrate "apply database migrations (backward compatible for one version)" migrate
fi
run_step restart "start the new containers" restart
run_step health "wait for https://$APP_ADDRESS to answer" health
run_step record "record $TAG as the running version" record

CURRENT_STEP=""
echo "deploy: done."
