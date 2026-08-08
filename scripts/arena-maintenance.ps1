<#
.SYNOPSIS
  Acquire/release a self-expiring Arena production maintenance lease.

.DESCRIPTION
  Do NOT disable ArenaWatchdog. Acquire writes data/runtime/maintenance.lease atomically.
  While the lease is fresh, the watchdog leaves production stopped. If the maintainer dies
  or forgets to release, the lease expires and watchdog auto-resumes on its next run.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)]
  [ValidateSet('acquire','release','status')]
  [string]$Action,
  [int]$TtlSeconds = 600,
  [string]$Reason = 'maintenance',
  [string]$DataRoot = 'ARENA_REPO_ROOT\data'
)
$ErrorActionPreference = 'Stop'
$runtime = Join-Path $DataRoot 'runtime'
$lease = Join-Path $runtime 'maintenance.lease'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null

switch ($Action) {
  'acquire' {
    if ($TtlSeconds -lt 30 -or $TtlSeconds -gt 3600) { throw 'TtlSeconds must be 30..3600' }
    $expires = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + $TtlSeconds
    $ownerPid = $PID
    $safeReason = ($Reason -replace "[`r`n]", ' ').Trim()
    $tmp = "$lease.$ownerPid.tmp"
    @("$expires", "$ownerPid", $safeReason) | Set-Content -LiteralPath $tmp -Encoding ascii
    Move-Item -Force -LiteralPath $tmp -Destination $lease
    [pscustomobject]@{ state='acquired'; expiresEpoch=$expires; ownerPid=$ownerPid; reason=$safeReason; path=$lease }
  }
  'release' {
    Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $lease
    [pscustomobject]@{ state='released'; path=$lease }
  }
  'status' {
    if (-not (Test-Path -LiteralPath $lease)) {
      [pscustomobject]@{ state='none'; path=$lease }
      break
    }
    $lines = @(Get-Content -LiteralPath $lease)
    $expires = if ($lines.Count -ge 1) { [long]$lines[0] } else { 0 }
    $ownerPid = if ($lines.Count -ge 2) { [int]$lines[1] } else { 0 }
    $reason = if ($lines.Count -ge 3) { $lines[2] } else { '' }
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    [pscustomobject]@{ state=if($expires -gt $now){'active'}else{'expired'}; expiresEpoch=$expires; ownerPid=$ownerPid; reason=$reason; path=$lease }
  }
}
