#!/usr/bin/env bash
# Arena 本地看护（用户授权自主维护，2026-08-06；t3/t4 已从 Rust 线收回 TS 线
# 2026-08-07）：每分钟检查本地 supervisor /ready；异常则确认旧进程死透 →
# 清理死锁 → 重启 live supervisor（t1-t4 全 TS 线；
# Rust 看护已退役 2026-08-07）。日志追加到 ~/arena-watchdog.log。
set -u

LOG="$HOME/arena-watchdog.log"
# supervisor 运行输出独立日志（2026-08-08）：watchdog 状态行与 supervisor stdout
# 并发 append 同一文件会把行写坏（实测 {"shuttingDown":true} 嵌进行、STALL/NOT
# ready 触发行丢失）——分开后 watchdog 触发原因可查、supervisor 输出可回看。
SUPERVISOR_LOG="$HOME/arena-supervisor.log"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_ROOT="/d/Code/Projects/arena/data"
RUNTIME_ROOT="$DATA_ROOT/runtime"
READY_URL="http://127.0.0.1:8120/ready"
COMMAND_CENTER_PORT="8787"
COMMAND_CENTER_URL="http://127.0.0.1:${COMMAND_CENTER_PORT}/api/alliance/director"
MAINTENANCE_LEASE="$RUNTIME_ROOT/maintenance.lease"

now() { date '+%Y-%m-%d %H:%M:%S'; }

# 维护租约（2026-08-08）：Scheduled Task 永远保持 Enabled。维护者只写一个
# 有明确过期时间的 lease，watchdog 在 lease 有效时暂不拉起生产；即使维护者
# 崩溃/终端断开，lease 过期后下一轮自动恢复，避免“任务被 Disabled 后永久停服”。
if [ -f "$MAINTENANCE_LEASE" ]; then
  LEASE_EXPIRES=$(sed -n '1p' "$MAINTENANCE_LEASE" | tr -d '\r')
  LEASE_REASON=$(sed -n '3p' "$MAINTENANCE_LEASE" | tr -d '\r')
  NOW_EPOCH=$(date +%s)
  if [[ "$LEASE_EXPIRES" =~ ^[0-9]+$ ]] && [ "$NOW_EPOCH" -lt "$LEASE_EXPIRES" ]; then
    exit 0
  fi
  echo "$(now) maintenance lease expired/invalid (${LEASE_REASON:-unknown}) -> auto-resume" >> "$LOG"
  rm -f "$MAINTENANCE_LEASE"
fi

# Command Center ownership（2026-08-08）：8787 必须由当前 release worktree 持有。
# 旧 main/临时 Agent 启动的实例即使占着端口也不能冒充生产；这里只替换 8787，
# 不触碰 supervisor/tenant writer。健康判断同时要求 v3 只读 Director 边界。
ensure_command_center() {
  local CC_PID EXPECTED_ROOT_WIN CC_BODY
  CC_PID=$(netstat -ano 2>/dev/null | grep ":${COMMAND_CENTER_PORT}" | grep -i LISTEN | head -1 | awk '{print $NF}')
  if [ -n "$CC_PID" ]; then
    EXPECTED_ROOT_WIN=$(cygpath -w "$REPO")
    if powershell -NoProfile -ExecutionPolicy Bypass -File "$REPO/scripts/command-center-owner.ps1" \
        -ProcessId "$CC_PID" -ExpectedRoot "$EXPECTED_ROOT_WIN" >/dev/null 2>&1; then
      CC_BODY=$(curl -sS -m 3 "$COMMAND_CENTER_URL" 2>/dev/null || true)
      if printf '%s' "$CC_BODY" | grep -q '"actionOwnership":"none"'; then
        return 0
      fi
    fi
    echo "$(now) Command Center wrong/stale owner pid=$CC_PID -> replacing with current release" >> "$LOG"
    taskkill //PID "$CC_PID" //T //F >> "$LOG" 2>&1 || true
    sleep 1
  fi
  (
    cd "$REPO/packages/command-center" || exit 1
    ARENA_DATA_ROOT="$DATA_ROOT" \
      ARENA_SUPERVISOR_DEBUG_URL="http://127.0.0.1:8120" \
      COMMAND_CENTER_PORT="$COMMAND_CENTER_PORT" \
      node scripts/start-cc.ts --hidden
  ) >> "$LOG" 2>&1 || true
}

ensure_command_center

# 健康则无事。注意：grep 必须取第一个 "ready" 字段（JSON 顶层），
# 否则 tenants 数组内其他租户的 "ready":true 会让子串匹配误判健康
# （2026-08-06 实测：t1 单线 failed 时 watchdog 因此漏恢复）。
READY=$(curl -sS -m 10 "$READY_URL" 2>/dev/null | grep -oE '"ready":(true|false)' | head -1)
if [ "$READY" = '"ready":true' ]; then
  # 第二道健康检查（2026-08-07 t1/t2 同时 stall 事件）：/ready 只证明进程
  # 存活，无法感知"连接半开但 tick 流停更"。outcome JSONL 超过 STALL_MAX_AGE_S
  # 未更新即视为 stall，走下方恢复路径（SDK 侧 idle 超时是主修复，此处兜底）。
  STALL_MAX_AGE_S=600
  STALL_TENANT=""
  for TENANT in t1 t2 t3 t4; do
    OUTCOME="$RUNTIME_ROOT/$TENANT/telemetry/outcome.jsonl"
    LOCK=$(ls "$RUNTIME_ROOT/$TENANT/locks/"*.lock 2>/dev/null | head -1)
    # 启动宽限：本轮 run 尚未产出首个 outcome 时（lock 新于 outcome），
    # 不得按旧 outcome mtime 误判 stall（否则恢复重启会被立刻再杀）。
    if [ -f "$OUTCOME" ] && [ -n "$LOCK" ] && [ "$(stat -c %Y "$OUTCOME")" -ge "$(stat -c %Y "$LOCK")" ]; then
      AGE_S=$(( $(date +%s) - $(stat -c %Y "$OUTCOME") ))
      if [ "$AGE_S" -gt "$STALL_MAX_AGE_S" ]; then
        STALL_TENANT="$TENANT"
        break
      fi
    fi
    # 决策停摆检查（2026-08-07 t2 实证后新增）：outcome 每 tick 照常落盘
    # （tick 推进正常）但策略 0 动作（agentActionCount==0 且 moveCount==0
    # 持续）→ 经济停摆——t2 曾 >600 tick 全 WAIT 无人发现。独立脚本判定，
    # 无 decision 遥测（新 run 宽限）返回 OK。
    if [ -z "$STALL_TENANT" ]; then
      DECISION_STALL=$(bash "$REPO/scripts/check-decision-stall.sh" "$DATA_ROOT" "$TENANT" 2>/dev/null)
      case "$DECISION_STALL" in
        STALL:*) STALL_TENANT="$TENANT";;
      esac
    fi
    # 经济停摆检查（2026-08-08 t1/t2/t3 复盘后新增）：决策活跃（单位在动）但
    # 满载 worker 持续 0 卸货、资源零增长——"假活"冻结（t1 1214 tick、t2
    # 2950 tick 全队持货 WAIT 实证）。decision-stall 只查"0 动作"查不到。
    if [ -z "$STALL_TENANT" ]; then
      ECONOMY_STALL=$(bash "$REPO/scripts/check-economy-stall.sh" "$DATA_ROOT" "$TENANT" 2>/dev/null)
      case "$ECONOMY_STALL" in
        STALL:*) STALL_TENANT="$TENANT";;
      esac
    fi
  done
  if [ -z "$STALL_TENANT" ]; then
    exit 0
  fi
  echo "$(now) STALL detected ($STALL_TENANT outcome stale > ${STALL_MAX_AGE_S}s or decision inactive) -> recovering" >> "$LOG"
else
  # 启动宽限（2026-08-08 11:17-11:32 重启循环实证）：/ready 未 true 但 8120 有
  # 监听 = supervisor 可能仍在启动/响应慢（45s 启动 > 60s 检查周期 → 每次在
  # ready 前被误杀 → 16 次连续重启，游戏每次只活 ~50s）。给 30s 再查一次，
  # 仍不健康才走恢复——慢启动不再是"必须杀"。
  LISTEN_PID=$(netstat -ano 2>/dev/null | grep ':8120' | grep -i LISTEN | head -1 | awk '{print $NF}')
  if [ -n "$LISTEN_PID" ]; then
    sleep 30
    READY2=$(curl -sS -m 10 "$READY_URL" 2>/dev/null | grep -oE '"ready":(true|false)' | head -1)
    if [ "$READY2" = '"ready":true' ]; then
      echo "$(now) supervisor booted within grace (first probe not ready) -> OK" >> "$LOG"
      exit 0
    fi
  fi
  echo "$(now) NOT ready -> recovering" >> "$LOG"
fi

# 1) 若 8120 还有监听（supervisor 半死），按端口强杀整个进程树
PID=$(netstat -ano 2>/dev/null | grep ':8120' | grep -i LISTEN | head -1 | awk '{print $NF}')
if [ -n "$PID" ]; then
  # 先试优雅关停（POST /shutdown → IPC arena.shutdown → recorder 写 manifest、
  #   cleanup stack 释放锁；2026-08-07 新增，防止硬杀丢失 run manifest）。
  curl -sS -m 3 -X POST "http://127.0.0.1:8120/shutdown" >> "$LOG" 2>&1 || true
  sleep 8
  # 优雅关停可能因 tenant 挂起而超时；8 秒后仍监听则按原路径硬杀兜底。
  STILL=$(netstat -ano 2>/dev/null | grep ':8120' | grep -i LISTEN | head -1 | awk '{print $NF}')
  if [ -n "$STILL" ]; then
    taskkill //PID "$PID" //T //F >> "$LOG" 2>&1
    sleep 3
  fi
fi

# 2) 再确认没有残留 run-tenant / run-supervisor 进程（双 writer 红线）。
# 旧版只 `head -1` 杀第一个 stray，随后无条件 rm 四租户锁；若 supervisor 树
# 尚有其他 child 存活，就会制造“writer 仍在写、single-writer lock 被删”的危险
# 假恢复（2026-08-08 生产实证）。现在循环清完整个集合，并在删锁前做最终硬门禁。
arena_pids() {
  # fail-closed（2026-08-08）：wmic 在本机已不可用（Win11 移除，实测
  # "wmic: command not found"）——旧版盲放行会删锁重启造成双 writer 假恢复，
  # 补丁版 fail-closed 又会让看护永远 ABORT（失去自动恢复）。改用 PowerShell
  # CIM 精确枚举 run-tenant/run-supervisor（排除 pm2/MCP 等无关 node 进程）。
  # 枚举失败（PS 不可用等）仍 fail-closed 保锁：绝不在"探测不到进程"时清锁。
  local OUT
  if ! OUT=$(powershell -NoProfile -ExecutionPolicy Bypass -File "$REPO/scripts/arena-pids.ps1" 2>/dev/null); then
    echo "PID_SCAN_UNAVAILABLE"
    return 1
  fi
  printf '%s
' "$OUT" | tr -d '
' | grep -E '^[0-9]+$' | sort -u
}
for ATTEMPT in 1 2 3; do
  STRAYS=$(arena_pids)
  [ -z "$STRAYS" ] && break
  for STRAY in $STRAYS; do
    taskkill //PID "$STRAY" //T //F >> "$LOG" 2>&1 || true
  done
  sleep 3
done
STRAYS=$(arena_pids)
if [ "$STRAYS" = "PID_SCAN_UNAVAILABLE" ]; then
  echo "$(now) ABORT recovery: process enumeration unavailable, cannot verify process absence; locks preserved" >> "$LOG"
  exit 1
fi
if [ -n "$STRAYS" ]; then
  echo "$(now) ABORT recovery: live arena process(es) still present after kill attempts: $STRAYS; locks preserved" >> "$LOG"
  exit 1
fi

# 3) 清理死锁——只有上面的最终进程门禁确认所有 writer/supervisor 都已退出后才允许。
rm -f "$RUNTIME_ROOT/t1/locks/"*.lock "$RUNTIME_ROOT/t2/locks/"*.lock "$RUNTIME_ROOT/t3/locks/"*.lock "$RUNTIME_ROOT/t4/locks/"*.lock

# 4) 重启 live supervisor（脱离当前会话，日志追加；--record-calibration 旁路
#    只记录 raw Runtime-Golden dataset；后续校准严格离线执行）
cd "$REPO" || exit 1
nohup npm run arena:supervisor -- --data-root="$DATA_ROOT" --configs=t1,t2,t3,t4 --mode=deterministic --live --record-calibration --record-alliance-shadow --alliance-shadow-interval-ticks=3 --alliance-director-shadow --alliance-director-period-ticks=4 --alliance-director-max-skew-ticks=2 --port=8120 >> "$SUPERVISOR_LOG" 2>&1 &
echo "$(now) supervisor restarted (pid $!, alliance-shadow=3 director=ASSIST_ONLY/period4/skew2)" >> "$LOG"
# 测绘库增量同步（2026-08-08，survey-db 联动）：重启后同步最新 run 的
# calibration case → 测绘库（幂等；供下次启动 seed + 面板 /api/survey）。
# 只读 calibration + 写 survey 库，与 supervisor 无 writer 冲突。
(cd "$REPO" && npm run survey:sync --silent -- --tenants=t1,t2,t3,t4 --latest-only) >> "$LOG" 2>&1 || true



