#!/bin/sh
set -eu

REPO_DIR="/srv/bots/openalice-paper-eval"
CONTAINER_NAME="openalice-paper-eval-openalice-1"
START_DATE="${OPENALICE_SMOKE_START_DATE:-2026-03-26}"
END_DATE="${OPENALICE_SMOKE_END_DATE:-2026-04-01}"
TZ_NAME="${OPENALICE_SMOKE_TIMEZONE:-America/New_York}"
LOG_DIR="$REPO_DIR/data/archive/smoke-tests"
LOG_FILE="$LOG_DIR/alpaca-smoke-week.log"

mkdir -p "$LOG_DIR"

TODAY="$(TZ="$TZ_NAME" date +%F)"
WEEKDAY="$(TZ="$TZ_NAME" date +%u)"
NOW_ISO="$(TZ="$TZ_NAME" date '+%Y-%m-%dT%H:%M:%S%z')"

log() {
  printf '%s %s\n' "$NOW_ISO" "$1" >> "$LOG_FILE"
}

if [ "$TODAY" \< "$START_DATE" ] || [ "$TODAY" \> "$END_DATE" ]; then
  log "skip outside-window today=$TODAY window=$START_DATE..$END_DATE"
  exit 0
fi

if [ "$WEEKDAY" -gt 5 ]; then
  log "skip weekend today=$TODAY weekday=$WEEKDAY"
  exit 0
fi

HEALTH="$(docker inspect --format='{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$CONTAINER_NAME" 2>/dev/null || true)"
case "$HEALTH" in
  "running healthy") ;;
  *)
    log "skip unhealthy container_status=$HEALTH"
    exit 0
    ;;
esac

log "start smoke-test today=$TODAY"
docker exec -w /app "$CONTAINER_NAME" node scripts/alpaca_trade_updates_smoke_test.mjs >> "$LOG_FILE" 2>&1
STATUS_JSON="$(curl -s http://127.0.0.1:3002/api/alpaca-eval/status || true)"
log "done status=$STATUS_JSON"
