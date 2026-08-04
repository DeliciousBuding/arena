# arena Go 全量门禁（Windows 等价入口，与 scripts/go-check.sh 同序）。
# PowerShell 5.1+ 兼容；任何一步失败即非零退出。
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

function Step([string]$name, [scriptblock]$body) {
    Write-Host "==> $name"
    & $body
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $null) { exit $LASTEXITCODE }
}

Step "go mod tidy" { go mod tidy }
Step "go mod verify" { go mod verify }
Step "gofmt" {
    $unformatted = gofmt -l .
    if ($unformatted) {
        Write-Host "gofmt: unformatted files:" -ForegroundColor Red
        $unformatted | ForEach-Object { Write-Host "  $_" }
        exit 1
    }
}
Step "go vet" { go vet ./... }
Step "staticcheck" { staticcheck ./... }
Step "govulncheck" { govulncheck ./... }
Step "build" {
    New-Item -ItemType Directory -Force bin | Out-Null
    go build -o bin/arena.exe ./cmd/arena
}
Step "test" {
    # Windows 上 TSAN 存在虚拟内存分配失败（error code 87）的已知限制；
    # race 检测由 CI（Linux, go-check.sh）强制执行。
    go test -count=1 ./...
}
Step "coverage" { go test -cover ./internal/... }

Write-Host "ALL CHECKS PASSED" -ForegroundColor Green
