# Arena watchdog process enumeration (Windows-native integration, AGENTS.md 11a
# exception: Windows 11 removed wmic, 2026-08-08 实测 wmic: command not found).
# Enumerate node.exe processes whose command line matches the arena supervisor /
# tenant entrypoints (run-tenant|run-supervisor), excluding pm2/MCP etc. Output
# PIDs one per line. Exit 0 on success (empty is fine); non-zero on failure so
# arena-watchdog.sh can fail-closed (preserve locks, no double-writer risk).
#
# 2026-08-10 作用域限定：只匹配 --data-root=<本机生产 data root> 的实例，
# 防止恢复流程的 killStrays 误杀其他 worktree / 其他 data-root 的开发实例
# （此前匹配所有 run-tenant|run-supervisor node 进程）。
$ErrorActionPreference = 'Stop'
try {
  $procs = Get-CimInstance Win32_Process -Filter "name='node.exe'"
  $procs | Where-Object {
    $_.CommandLine -match 'run-tenant|run-supervisor|arena:supervisor' -and
    $_.CommandLine -match '--data-root=ARENA_REPO_ROOT/data'
  } | ForEach-Object { $_.ProcessId }
  exit 0
} catch {
  exit 1
}
