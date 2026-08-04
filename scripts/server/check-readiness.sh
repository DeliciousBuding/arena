#!/usr/bin/env bash
# Host-side readiness probe for a Dockerized Arena supervisor.
# Usage: check-readiness.sh <systemd-unit> <compose-service>
#
# Skips when the systemd unit is inactive (maintenance/timer noise guard), then
# runs the canonical healthcheck inside the container, so the host needs no Node.
set -euo pipefail

unit="${1:?systemd unit required, e.g. arena-supervisor-shadow.service}"
service="${2:?compose service required, e.g. shadow}"
compose_file="/opt/arena/current/deploy/docker/arena-compose.yml"
port="${ARENA_DEBUG_PORT:-8120}"

if ! systemctl is-active --quiet "$unit"; then
  echo '{"ok":true,"skipped":true,"reason":"systemd_unit_inactive"}'
  exit 0
fi

exec docker compose -f "$compose_file" exec -T "$service" \
  node scripts/server/healthcheck.mjs --skip-disk --url="http://127.0.0.1:${port}/ready"
