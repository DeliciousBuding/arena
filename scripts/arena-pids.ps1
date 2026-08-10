# Arena watchdog process enumeration (Windows-native integration, AGENTS.md 11a
# exception: Windows 11 removed wmic, 2026-08-08 实测 wmic: command not found).
# Enumerate node.exe processes whose command line matches the arena supervisor /
# tenant entrypoints (run-tenant|run-supervisor), excluding pm2/MCP etc. Output
# PIDs one per line. Exit 0 on success (empty is fine); non-zero on failure so
# arena-watchdog can fail-closed (preserve locks, no double-writer risk).
#
# 2026-08-10 限定：只匹配 --data-root=<当前生产 data root> 的真实实例，
# 防止恢复流程的 killStrays 杀掉其他 worktree / 其他 data-root 的对照实例
# （此前匹配所有 run-tenant|run-supervisor node 进程）。
#
# 2026-08-10 修复：data root 用 env(ARENA_REPO_ROOT) 展开、缺省回落真实路径
# （历史重写曾把机器路径替换成字面量 ARENA_REPO_ROOT/data，导致匹配永远
# 失败、killStrays 清不掉残留租户进程——与 watchdog DEFAULT_DATA_ROOT 同款
# 修复，2026-08-10 v16）。
$ErrorActionPreference = 'Stop'
try {
  $dataRoot = if ($env:ARENA_REPO_ROOT) {
    Join-Path $env:ARENA_REPO_ROOT 'data'
  } else {
    'D:\Code\Projects\arena\data'
  }
  # 命令行路径分隔符混用（supervisor 正斜杠、租户反斜杠），匹配前统一正斜杠
  $dataRoot = ($dataRoot -replace '\\', '/')
  $dataRootPattern = '--data-root[= ]' + [regex]::Escape($dataRoot)
  $procs = Get-CimInstance Win32_Process -Filter "name='node.exe'"
  $procs | Where-Object {
    $cmdLine = $_.CommandLine -replace '\\', '/'
    $cmdLine -match 'run-tenant|run-supervisor|arena:supervisor' -and
    $cmdLine -match $dataRootPattern
  } | ForEach-Object { $_.ProcessId }
  exit 0
} catch {
  exit 1
}
