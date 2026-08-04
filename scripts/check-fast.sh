#!/usr/bin/env bash
# 快速循环：开发过程中反复跑（几十秒内反馈）
set -euo pipefail
cd "$(dirname "$0")/.."
gofmt -l .
go build ./cmd/arena
go test ./internal/domain/... ./internal/strategy/... ./internal/runtime/... ./internal/hero/... 2>/dev/null || go test ./internal/...
echo "FAST CHECKS PASSED"
