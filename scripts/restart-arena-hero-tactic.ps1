<#
.SYNOPSIS
  Restart arena-hero-tactic v2 production instances (default t2/t3/t4).

.DESCRIPTION
  Launches one bot instance per tenant using the arena-hero-tactic repo's
  own .venv python (fork SDK editable install: arena-hero-sdk-py,
  0.2.9-telemetry.3), with cwd = data/runtime/waaiging/<t> so each instance's
  .env (API key / telemetry endpoint / tenant) and runtime files resolve per
  instance. v2 memory filename (.arena_hero_state.json) differs from waaiging
  v1, so sharing cwd is safe. Pre-rotation: tactic.log -> tactic.log.pre-*.

  This script only STARTS instances - it never stops anything. It also never
  reads or prints API keys; credentials are loaded by the tactic from each
  instance's own .env at runtime.

  v2 agent code is untouched (third-party minimal-change discipline 2026-08-09):
  telemetry / mapping / unit composition capture is fully carried by the fork
  SDK (tick_summary telemetry-v3); this script only picks venv + cwd + logs.

.EXAMPLE
  # Default: restart t2, t3, t4
  ./scripts/restart-arena-hero-tactic.ps1

.EXAMPLE
  # Only t2, custom repo/runtime roots
  ./scripts/restart-arena-hero-tactic.ps1 -Tenants t2 -Repo D:\repo\arena-hero-tactic

.NOTES
  One-time setup (done by the deploy session):
    python -m venv reference/third-party/arena-hero-tactic/.venv
    .venv\Scripts\python.exe -m pip install -e arena-hero-sdk-py python-dotenv
  After launch verify:
    - tactic.log grows every tick
    - tactic.err.log stays small (only startup noise / transient errors)
    - ledger fresh: survey/<t>.db agents table updated_at refreshes and
      vanguards/rangers columns get values (controlled_by_type telemetry-v3)
#>
[CmdletBinding()]
param(
  [string[]]$Tenants = @('t2', 't3', 't4'),
  [string]$Repo = '',
  [string]$Runtime = ''
)
$ErrorActionPreference = 'Stop'
if (-not $Repo) {
  $Repo = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'reference\third-party\arena-hero-tactic'
}
if (-not $Runtime) {
  $dataRoot = if ($env:ARENA_DATA_ROOT) { $env:ARENA_DATA_ROOT }
              else { Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'data' }
  $Runtime = Join-Path $dataRoot 'runtime\waaiging'
}

$python = Join-Path $Repo '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
  throw "venv python not found: $python - create venv first (see .NOTES)"
}

foreach ($t in $Tenants) {
  $cwd = Join-Path $Runtime $t
  if (-not (Test-Path -LiteralPath $cwd)) { throw "tenant runtime dir missing: $cwd" }
  $envFile = Join-Path $cwd '.env'
  if (-not (Test-Path -LiteralPath $envFile)) {
    throw "tenant .env missing: $envFile (needs ARENA_HERO_API_KEY / ARENA_HERO_TELEMETRY_ENDPOINT / ARENA_HERO_TENANT)"
  }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $log = Join-Path $cwd 'tactic.log'
  if (Test-Path -LiteralPath $log) {
    Copy-Item -LiteralPath $log -Destination (Join-Path $cwd "tactic.log.pre-restart-$stamp") -Force
  }
  # v2 load_api_key only reads repo/.env + find_dotenv (upward from repo root);
  # it does NOT read the instance cwd .env - inject the three vars from the
  # instance .env into the process env (values never printed); SDK telemetry
  # env is injected the same way (fork SDK reads os.environ).
  $envVars = @('ARENA_HERO_API_KEY', 'ARENA_HERO_TELEMETRY_ENDPOINT', 'ARENA_HERO_TENANT')
  foreach ($v in $envVars) { Remove-Item "Env:$v" -ErrorAction SilentlyContinue }
  Get-Content -LiteralPath $envFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#')) {
      $eq = $line.IndexOf('=')
      if ($eq -gt 0) {
        $name = $line.Substring(0, $eq).Trim()
        $value = $line.Substring($eq + 1).Trim()
        if ($envVars -contains $name) { Set-Item "Env:$name" $value }
      }
    }
  }
  # python -m bot.main resolves modules from cwd (instance dir, no bot pkg) -
  # inject PYTHONPATH=repo root so the bot package imports; Start-Process
  # inherits the current environment.
  $oldPyPath = $env:PYTHONPATH
  $env:PYTHONPATH = $Repo
  Start-Process -FilePath $python `
    -ArgumentList '-m', 'bot.main' `
    -WorkingDirectory $cwd `
    -WindowStyle Hidden `
    -RedirectStandardOutput $log `
    -RedirectStandardError (Join-Path $cwd 'tactic.err.log')
  $env:PYTHONPATH = $oldPyPath
  Write-Host "launched $t (python=$python, module=bot.main)"
  Start-Sleep -Milliseconds 1500
}

Write-Host ''
Write-Host 'Self-check (per tenant):'
Write-Host '  1. tactic.log advances: Get-Content data/runtime/waaiging/<t>/tactic.log -Tail 3'
Write-Host '  2. tactic.err.log stays small: Get-Content data/runtime/waaiging/<t>/tactic.err.log -Tail 5'
Write-Host '  3. ledger fresh: survey/<t>.db agents table updated_at refreshes + vanguards/rangers non-null'
