<#
.SYNOPSIS
  Restart waaiging bot instances (default t2/t3/t4) after a stop.

.DESCRIPTION
  Launches one arena_hero_tactic.py process per tenant using the waaiging repo's
  own .venv python, with cwd = data/runtime/waaiging/<t> so the .env / runtime
  files resolve per instance. Pre-rotation: each existing tactic.log is copied
  to tactic.log.pre-restart-<stamp> before the new process redirects into it.

  This script only STARTS instances - it never stops anything. It also never
  reads or prints API keys; credentials are loaded by the tactic from each
  instance's own .env at runtime.

.EXAMPLE
  # Default: restart t2, t3, t4
  ./scripts/restart-waaiging.ps1

.EXAMPLE
  # Only t2 and t3, with custom repo/runtime roots
  ./scripts/restart-waaiging.ps1 -Tenants t2,t3 -Repo C:\path\to\waaiging -Runtime C:\path\to\runtime\waaiging

.NOTES
  After launch, verify each instance is alive:
    - tactic.log grows every tick (tail -f data/runtime/waaiging/<t>/tactic.log)
    - tactic.err.log stays small (only startup noise / transient errors)
    - arena_hero_telemetry.jsonl / arena_hero_events_zh.jsonl get fresh rows
#>
[CmdletBinding()]
param(
  [string[]]$Tenants = @('t2', 't3', 't4'),
  [string]$Repo = '',
  [string]$Runtime = ''
)
$ErrorActionPreference = 'Stop'
if (-not $Repo) {
  $Repo = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'reference\third-party\arena-hero-clone-waaiging'
}
if (-not $Runtime) {
  $dataRoot = if ($env:ARENA_DATA_ROOT) { $env:ARENA_DATA_ROOT }
              else { Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'data' }
  $Runtime = Join-Path $dataRoot 'runtime\waaiging'
}

$python = Join-Path $Repo '.venv\Scripts\python.exe'
$tactic = Join-Path $Repo 'arena_hero_tactic.py'
if (-not (Test-Path -LiteralPath $python)) { throw "python not found: $python" }
if (-not (Test-Path -LiteralPath $tactic)) { throw "tactic not found: $tactic" }

foreach ($t in $Tenants) {
  $cwd = Join-Path $Runtime $t
  if (-not (Test-Path -LiteralPath $cwd)) { throw "tenant runtime dir missing: $cwd" }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $log = Join-Path $cwd 'tactic.log'
  if (Test-Path -LiteralPath $log) {
    Copy-Item -LiteralPath $log -Destination (Join-Path $cwd "tactic.log.pre-restart-$stamp") -Force
  }
  Start-Process -FilePath $python `
    -ArgumentList $tactic `
    -WorkingDirectory $cwd `
    -WindowStyle Hidden `
    -RedirectStandardOutput $log `
    -RedirectStandardError (Join-Path $cwd 'tactic.err.log')
  Write-Host "launched $t (python=$python)"
  Start-Sleep -Milliseconds 1500
}

Write-Host ''
Write-Host 'Self-check (per tenant):'
Write-Host '  1. tactic.log advances: Get-Content data/runtime/waaiging/<t>/tactic.log -Tail 3'
Write-Host '  2. tactic.err.log stays small: Get-Content data/runtime/waaiging/<t>/tactic.err.log -Tail 5'
Write-Host '  3. telemetry/events jsonl get fresh rows: data/runtime/waaiging/<t>/'
