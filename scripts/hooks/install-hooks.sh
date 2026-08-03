#!/bin/sh
# 安装 arena 防泄露 hooks 到 .git/hooks/
# 用法：sh scripts/hooks/install-hooks.sh（Windows PowerShell 下同样可用）
set -u

HOOK_SRC="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/pre-commit"
HOOK_DST="$(git rev-parse --git-dir 2>/dev/null)/hooks/pre-commit"

if [ -z "$HOOK_DST" ] || [ "$HOOK_DST" = "/hooks/pre-commit" ]; then
  echo "error: 不在 git 仓库内，无法安装" >&2
  exit 1
fi

if [ -f "$HOOK_DST" ] && ! grep -q "arena 防泄露" "$HOOK_DST" 2>/dev/null; then
  echo "error: $HOOK_DST 已存在且不是 arena hook，请人工处理" >&2
  exit 1
fi

cp "$HOOK_SRC" "$HOOK_DST"
chmod +x "$HOOK_DST" 2>/dev/null || true
echo "installed: $HOOK_DST"
echo "下次 git commit 自动生效；SKIP_ARENA_SECRET_CHECK=1 可豁免（慎用）"
