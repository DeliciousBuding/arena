#!/usr/bin/env bash
# arena Go 全量门禁（唯一入口，与 scripts/go-check.ps1 等价）。
# 本地与 CI 执行同一命令；任何一步失败即非零退出。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> go mod tidy"
go mod tidy
echo "==> go mod verify"
go mod verify
echo "==> gofmt"
unformatted=$(gofmt -l .)
if [ -n "$unformatted" ]; then
  echo "gofmt: unformatted files:" >&2
  echo "$unformatted" >&2
  exit 1
fi
echo "==> go vet"
go vet ./...
echo "==> staticcheck"
staticcheck ./...
echo "==> govulncheck"
govulncheck ./...
echo "==> build"
mkdir -p bin
go build -ldflags "-X github.com/deliciousbuding/arena/internal/version.sha=$(git rev-parse HEAD 2>/dev/null || echo unknown) -X github.com/deliciousbuding/arena/internal/version.builtAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)" -o bin/arena ./cmd/arena
echo "==> test -race"
go test -race -count=1 ./...
echo "==> coverage"
go test -cover ./internal/...
echo "==> consistency"
if [ -f scripts/check-consistency.py ]; then python3 scripts/check-consistency.py; fi

echo "ALL CHECKS PASSED"
