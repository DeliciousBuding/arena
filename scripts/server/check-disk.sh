#!/usr/bin/env bash
# Host-side disk gate for the Arena runtime filesystem.
# Pure POSIX tools (df), no Node required; fails closed when free space is
# below ARENA_MIN_FREE_BYTES or the filesystem cannot be inspected.
set -euo pipefail

runtime_dir="${ARENA_RUNTIME_DIR:-/var/lib/arena}"
min_free="${ARENA_MIN_FREE_BYTES:-1073741824}"

if ! [[ "$min_free" =~ ^[0-9]+$ ]]; then
  echo "ARENA_MIN_FREE_BYTES is not a non-negative integer: ${min_free}" >&2
  exit 1
fi

free_bytes="$(df -B1 --output=avail "$runtime_dir" 2>/dev/null | tail -n1 | tr -d ' ')"
if [[ -z "$free_bytes" || ! "$free_bytes" =~ ^[0-9]+$ ]]; then
  echo "cannot determine free bytes for ${runtime_dir}" >&2
  exit 1
fi
if (( free_bytes < min_free )); then
  echo "runtime filesystem free bytes ${free_bytes} below minimum ${min_free}" >&2
  exit 1
fi

echo "{\"ok\":true,\"mode\":\"disk\",\"runtimeDir\":\"${runtime_dir}\",\"freeBytes\":${free_bytes},\"minFreeBytes\":${min_free}}"
