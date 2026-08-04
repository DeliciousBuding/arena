#!/usr/bin/env bash
set -euo pipefail

mode="${1:-${ARENA_SERVICE_MODE:-}}"
repo_root="${ARENA_REPO_ROOT:-/opt/arena/current}"
config_dir="${ARENA_CONFIG_DIR:-/etc/arena/configs}"
runtime_dir="${ARENA_RUNTIME_DIR:-/var/lib/arena}"
configs="${ARENA_CONFIGS:-t1,t2,t3,t4}"
debug_port="${ARENA_DEBUG_PORT:-8120}"
debug_host="${ARENA_DEBUG_HOST:-}"
shutdown_timeout_ms="${ARENA_SHUTDOWN_TIMEOUT_MS:-15000}"
tsx_bin="$repo_root/node_modules/.bin/tsx"

case "$mode" in
  shadow|live) ;;
  *)
    echo "usage: run-supervisor.sh <shadow|live>" >&2
    exit 64
    ;;
esac

for required in "$repo_root" "$config_dir" "$runtime_dir"; do
  if [[ ! -d "$required" ]]; then
    echo "required directory missing: $required" >&2
    exit 78
  fi
done
if [[ ! -x "$tsx_bin" ]]; then
  echo "tsx executable missing: $tsx_bin" >&2
  exit 78
fi

args=(
  "--repo-root=$repo_root"
  "--config-dir=$config_dir"
  "--runtime-dir=$runtime_dir"
  "--configs=$configs"
  "--port=$debug_port"
  "--shutdown-timeout-ms=$shutdown_timeout_ms"
)

if [[ -n "${ARENA_STARTUP_SYNC_TICKS:-}" ]]; then
  args+=("--startup-sync-ticks=${ARENA_STARTUP_SYNC_TICKS}")
fi
if [[ -n "$debug_host" ]]; then
  args+=("--debug-host=$debug_host")
fi

case "$mode" in
  shadow)
    # Server shadow remains deterministic until the Pi HTTP dependency is patched and re-audited.
    args+=("--mode=deterministic" "--shadow")
    ;;
  live)
    # Production default remains deterministic. Hybrid promotion is a separate gate.
    args+=("--mode=deterministic" "--live")
    ;;
esac

cd "$repo_root"
exec "$tsx_bin" packages/arena-agent/src/cli/run-supervisor.ts "${args[@]}"
