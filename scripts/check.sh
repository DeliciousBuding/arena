#!/usr/bin/env bash
# Commit 级：每次提交前
set -euo pipefail
cd "$(dirname "$0")/.."
gofmt -l .
go vet ./...
go build ./cmd/arena
go test -count=1 ./...
echo "COMMIT CHECKS PASSED"
