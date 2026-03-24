#!/bin/sh
set -eu

node /app/scripts/bootstrap_vps_config.mjs

exec "$@"
