#!/usr/bin/env bash
# Arena release rollback helper (Docker image tag).
#
# Switches /opt/arena/current/deploy/docker/arena-compose.yml from the rolling
# :main tag to a pinned git-sha or semantic version tag (or back), atomically
# and with a backup. Designed for the systemd-managed shadow/live services:
#   systemctl stop  →  switch tag  →  systemctl start
#
# Usage:
#   bash deploy/docker/rollback.sh --to=<git-sha>|vX.Y.Z|main [--compose=/path/to/arena-compose.yml] [--service=shadow|live|both] [--apply]
#
# Safety:
#   - refuses to run without --apply (dry-run by default)
#   - verifies the target tag exists in GHCR before touching the compose file
#   - backs up the original compose file next to it (arena-compose.yml.bak-<ts>)
#   - after --apply with --service, verifies the service is active and the
#     container image actually matches the requested tag
set -euo pipefail

compose="${ARENA_COMPOSE_FILE:-/opt/arena/current/deploy/docker/arena-compose.yml}"
image_base="ghcr.io/deliciousbuding/arena"
service="both"
apply=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --to=*) target="${1#--to=}" ;;
    --compose=*) compose="${1#--compose=}" ;;
    --service=*) service="${1#--service=}" ;;
    --apply) apply=true ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
  shift
done
if [[ -z "${target:-}" ]]; then
  echo "usage: rollback.sh --to=<git-sha>|vX.Y.Z|main [--service=shadow|live|both] [--apply]" >&2
  exit 64
fi
case "$service" in
  shadow|live|both) ;;
  *) echo "invalid --service: $service" >&2; exit 64 ;;
esac

if [[ ! -f "$compose" ]]; then
  echo "compose file not found: $compose" >&2
  exit 78
fi

target_image="$image_base:$target"

# Dry-run default: report what would change without touching anything.
echo "compose: $compose"
echo "target:  $target_image"
if grep -q "image: $image_base:[A-Za-z0-9.-]*$" "$compose"; then
  echo "current image refs will be replaced by $target_image"
fi
if [[ "$apply" != true ]]; then
  echo "(dry-run; re-run with --apply to execute)"
  exit 0
fi

# 1. Verify the target tag exists in GHCR (fail-closed before any mutation).
if ! docker manifest inspect "$target_image" > /dev/null 2>&1; then
  echo "image tag not found in GHCR: $target_image" >&2
  exit 78
fi

# 2. Backup the original compose file (atomic-ish: same dir, timestamped).
backup="$compose.bak-$(date +%Y%m%d%H%M%S)"
cp -p "$compose" "$backup"
echo "backup: $backup"

# 3. Replace every rolling image reference with the pinned target.
tmp="${compose}.rollback-tmp"
sed "s|image: $image_base:[A-Za-z0-9.-]*|image: $target_image|g" "$backup" > "$tmp"
mv -f "$tmp" "$compose"
echo "compose updated: $(grep -c "image: $target_image" "$compose") image ref(s) → $target_image"

# 4. Restart the requested service(s) and verify.
restart_service() {
  local name="$1"
  if ! systemctl list-unit-files "$name.service" > /dev/null 2>&1; then
    echo "systemd unit not found: $name" >&2
    return 1
  fi
  systemctl stop "$name.service"
  systemctl start "$name.service"
  local container
  container="$(docker compose -f "$compose" ps -q "$name" 2>/dev/null | head -n1 || true)"
  if [[ -z "$container" ]]; then
    echo "container for $name not running after start" >&2
    return 1
  fi
  local actual
  actual="$(docker inspect --format '{{.Config.Image}}' "$container" 2>/dev/null || true)"
  if [[ "$actual" != "$target_image" ]]; then
    echo "image mismatch for $name: expected $target_image, got $actual" >&2
    return 1
  fi
  echo "verified: $name running $actual"
}

failed=0
if [[ "$service" == "shadow" || "$service" == "both" ]]; then
  restart_service shadow || failed=1
fi
if [[ "$service" == "live" || "$service" == "both" ]]; then
  restart_service live || failed=1
fi

if [[ "$failed" -ne 0 ]]; then
  echo "rollback incomplete; restore with: cp $backup $compose && systemctl restart $service" >&2
  exit 1
fi
echo "rollback complete: $target_image"
