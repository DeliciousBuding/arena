# Arena watchdog process enumeration (Windows-native integration, AGENTS.md 11a
# exception: Windows 11 removed wmic, 2026-08-08 实测 wmic: command not found).
# Enumerate node.exe processes whose command line matches the arena supervisor /
# tenant entrypoints (run-tenant|run-supervisor), excluding pm2/MCP etc. Output
# PIDs one per line. Exit 0 on success (empty is fine); non-zero on failure so
# arena-watchdog.sh can fail-closed (preserve locks, no double-writer risk).
$ErrorActionPreference = 'Stop'
try {
  $procs = Get-CimInstance Win32_Process -Filter "name='node.exe'"
  $procs | Where-Object { $_.CommandLine -match 'run-tenant|run-supervisor|arena:supervisor' } | ForEach-Object { $_.ProcessId }
  exit 0
} catch {
  exit 1
}
