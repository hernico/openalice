#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SOURCE_ROOT=${OPENALICE_ARCHIVE_SOURCE_ROOT:-"$REPO_ROOT/data"}
ARCHIVE_ROOT=${OPENALICE_ARCHIVE_ROOT:-"$REPO_ROOT/data/archive/monthly"}

CURRENT_MONTH=$(date -u '+%Y-%m')
PREVIOUS_MONTH=$(date -u -d "$(date -u '+%Y-%m-01') -1 month" '+%Y-%m')
CURRENT_DAY=$(date -u '+%d')
INCLUDE_PREVIOUS_MONTH_DAYS=${OPENALICE_ARCHIVE_INCLUDE_PREVIOUS_MONTH_DAYS:-3}

python3 "$SCRIPT_DIR/build_monthly_eval_db.py" \
  --month "$CURRENT_MONTH" \
  --source-root "$SOURCE_ROOT" \
  --archive-root "$ARCHIVE_ROOT"

if [ "$PREVIOUS_MONTH" != "$CURRENT_MONTH" ] && [ "$CURRENT_DAY" -le "$INCLUDE_PREVIOUS_MONTH_DAYS" ]; then
  python3 "$SCRIPT_DIR/build_monthly_eval_db.py" \
    --month "$PREVIOUS_MONTH" \
    --source-root "$SOURCE_ROOT" \
    --archive-root "$ARCHIVE_ROOT"
fi
