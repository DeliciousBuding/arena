[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][int]$ProcessId,
  [Parameter(Mandatory=$true)][string]$ExpectedRoot
)
$ErrorActionPreference = 'Stop'
$proc = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
if ($null -eq $proc -or [string]::IsNullOrWhiteSpace($proc.CommandLine)) { exit 1 }
$expected = [IO.Path]::GetFullPath([IO.Path]::Combine($ExpectedRoot, 'packages', 'command-center', 'server.ts'))
$actual = $proc.CommandLine
if ($actual.IndexOf($expected, [StringComparison]::OrdinalIgnoreCase) -ge 0) { exit 0 }
exit 1
