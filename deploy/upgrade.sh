#!/usr/bin/env bash
# Arena 一键升级（docs/design/deploy-fast-upgrade.md）：
#
#   用法：sudo /opt/arena/upgrade.sh <tag>            # 升级 live 到镜像 tag
#         sudo /opt/arena/upgrade.sh <tag> --rollback  # 显式回滚到上一 pin（-r 同义）
#
# 版本 pin 单源：/opt/arena/version.env（systemd EnvironmentFile 注入，compose 引用
# ${ARENA_LIVE_IMAGE:-...}——release 目录重建/镜像重建都不会丢失 pin）。
# 升级失败（健康门禁超时）自动恢复旧 pin 并重新拉起，无需人工干预。
set -euo pipefail

TAG="${1:?usage: upgrade.sh <tag> [--rollback]}"
ROLLBACK="${2:-}"
if [[ "$ROLLBACK" == "-r" ]]; then ROLLBACK="--rollback"; fi
if [[ -n "$ROLLBACK" && "$ROLLBACK" != "--rollback" ]]; then
  echo "unknown flag: $ROLLBACK" >&2
  exit 2
fi

COMPOSE_FILE="${ARENA_COMPOSE_FILE:-/opt/arena/deploy/arena-compose.yml}"
VERSION_ENV="${ARENA_VERSION_ENV:-/opt/arena/version.env}"
READY_URL="${ARENA_READY_URL:-http://127.0.0.1:8120/ready}"
MAX_ATTEMPTS="${ARENA_UPGRADE_MAX_ATTEMPTS:-5}"
ATTEMPT_SLEEP_S="${ARENA_UPGRADE_ATTEMPT_SLEEP_S:-30}"

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "compose file not found: $COMPOSE_FILE" >&2
  exit 2
fi
if [[ ! -f "$VERSION_ENV" ]]; then
  echo "version env not found: $VERSION_ENV (init: echo 'ARENA_LIVE_IMAGE=ghcr.io/deliciousbuding/arena:<tag>' > $VERSION_ENV)" >&2
  exit 2
fi

IMAGE="ghcr.io/deliciousbuding/arena:${TAG}"

if [[ "$ROLLBACK" == "--rollback" && ! -f "${VERSION_ENV}.bak" ]]; then
  echo "no rollback backup at ${VERSION_ENV}.bak" >&2
  exit 2
fi

apply_pin() {
  # 只替换 ARENA_LIVE_IMAGE 行；不存在则追加（首次初始化）
  if grep -q '^ARENA_LIVE_IMAGE=' "$VERSION_ENV"; then
    sed -i "s|^ARENA_LIVE_IMAGE=.*|ARENA_LIVE_IMAGE=${IMAGE}|" "$VERSION_ENV"
  else
    echo "ARENA_LIVE_IMAGE=${IMAGE}" >> "$VERSION_ENV"
  fi
}

restart_live() {
  docker compose -f "$COMPOSE_FILE" up -d --pull always live
}

wait_healthy() {
  for _ in $(seq 1 "$MAX_ATTEMPTS"); do
    if curl -fsS -m 5 "$READY_URL" 2>/dev/null | grep -q '"ready":true'; then
      return 0
    fi
    sleep "$ATTEMPT_SLEEP_S"
  done
  return 1
}

echo "== arena upgrade: ${TAG} (rollback=${ROLLBACK:-no})"
if [[ "$ROLLBACK" == "--rollback" ]]; then
  cp "${VERSION_ENV}.bak" "$VERSION_ENV"
  restart_live
  if wait_healthy; then
    echo "== rollback OK: $(grep '^ARENA_LIVE_IMAGE=' "$VERSION_ENV")"
    exit 0
  fi
  echo "== rollback failed: live not healthy" >&2
  exit 1
fi

cp "$VERSION_ENV" "${VERSION_ENV}.bak"
apply_pin
echo "== pulling ${IMAGE}"
docker pull "$IMAGE"
restart_live
if wait_healthy; then
  echo "== upgrade OK: ${IMAGE}"
  exit 0
fi

echo "== live not healthy after upgrade; rolling back to previous pin" >&2
cp "${VERSION_ENV}.bak" "$VERSION_ENV"
restart_live
if wait_healthy; then
  echo "== rolled back: $(grep '^ARENA_LIVE_IMAGE=' "$VERSION_ENV")"
else
  echo "== rollback also failed; manual recovery required" >&2
  exit 1
fi
