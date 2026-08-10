#!/usr/bin/env bash
# Arena 本地看护：每分钟检查本地 supervisor /ready；异常则确认旧进程死透 →
# 清理死锁 → 重启 live supervisor。日志追加到 ~/arena-watchdog.log。
# 租户范围由环境变量 ARENA_TENANTS 显式提供（逗号分隔，非空），本脚本不
# 内置任何租户名；缺失或非法一律 fail closed，不进入恢复路径。
set -u

LOG="$HOME/arena-watchdog.log"
# supervisor 运行输出独立日志：watchdog 状态行与 supervisor stdout 分开，
# 避免并发 append 同一文件把行写坏。
SUPERVISOR_LOG="$HOME/arena-supervisor.log"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_ROOT="${ARENA_DATA_ROOT:-$(cd "$REPO/.." && pwd)/data}"
RUNTIME_ROOT="$DATA_ROOT/runtime"
READY_URL="http://127.0.0.1:8120/ready"
MAINTENANCE_LEASE="$RUNTIME_ROOT/maintenance.lease"

now() { date '+%Y-%m-%d %H:%M:%S'; }

# 租户范围门禁（fail closed）：ARENA_TENANTS 必须是非空逗号列表，逐项校验
# 命名规则 ^[a-z0-9][a-z0-9._-]{0,63}$；缺失或任一非法即拒绝继续，绝不以
# 缺省租户集继续恢复（避免恢复错对象）。
TENANT_LIST=""
TENANTS_CSV=""
if [ -z "${ARENA_TENANTS:-}" ]; then
  echo "$(now) ABORT: ARENA_TENANTS is required (non-empty comma-separated tenant list)" >> "$LOG"
  exit 1
fi
for TENANT in $(printf '%s' "$ARENA_TENANTS" | tr ',' '\n'); do
  if [[ ! "$TENANT" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]]; then
    echo "$(now) ABORT: invalid tenant name in ARENA_TENANTS: '$TENANT'" >> "$LOG"
    exit 1
  fi
  TENANT_LIST="${TENANT_LIST:+$TENANT_LIST }$TENANT"
  if [ -n "$TENANTS_CSV" ]; then
    TENANTS_CSV="$TENANTS_CSV,$TENANT"
  else
    TENANTS_CSV="$TENANT"
  fi
done

# 维护租约：维护者只写一个有明确过期时间的 lease，watchdog 在 lease 有效时
# 暂不拉起实例；即使维护者崩溃，lease 过期后下一轮自动恢复。
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

# 健康则无事。注意：grep 必须取第一个 "ready" 字段（JSON 顶层），
# 否则 tenants 数组内其他租户的 "ready":true 会让子串匹配误判健康（漏恢复）。
READY=$(curl -sS -m 10 "$READY_URL" 2>/dev/null | grep -oE '"ready":(true|false)' | head -1)
if [ "$READY" = '"ready":true' ]; then
  # 第二道健康检查：/ready 只证明进程存活，无法感知"连接半开但 tick 流停更"。
  # outcome JSONL 超过 STALL_MAX_AGE_S 未更新即视为 stall，走下方恢复路径
  # （SDK 侧 idle 超时是主修复，此处兜底）。
  STALL_MAX_AGE_S=600
  STALL_TENANT=""
  for TENANT in $TENANT_LIST; do
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
    # 决策停摆检查：outcome 每 tick 照常落盘但策略 0 动作
    # （agentActionCount==0 且 moveCount==0 持续）→ 决策停摆。独立脚本判定，
    # 无 decision 遥测（新 run 宽限）返回 OK。
    if [ -z "$STALL_TENANT" ]; then
      DECISION_STALL=$(bash "$REPO/scripts/check-decision-stall.sh" "$DATA_ROOT" "$TENANT" 2>/dev/null)
      case "$DECISION_STALL" in
        STALL:*) STALL_TENANT="$TENANT";;
      esac
    fi
    # 经济停摆检查：决策活跃（单位在动）但满载 worker 持续 0 卸货、资源零增长
    # ——"假活"冻结。decision-stall 只查"0 动作"查不到。
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
  # 启动宽限：/ready 未 true 但 8120 有监听 = supervisor 可能仍在启动/响应慢。
  # 给 30s 再查一次，仍不健康才走恢复。
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
  #   cleanup stack 释放锁；防止硬杀丢失 run manifest）。
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
# 旧版只 `head -1` 杀第一个 stray，随后无条件 rm 全部实例锁；若 supervisor 树
# 尚有其他 child 存活，就会制造“writer 仍在写、single-writer lock 被删”的危险
# 假恢复。现在循环清完整个集合，并在删锁前做最终硬门禁。
arena_pids() {
  # fail-closed：wmic 在 Win11 已移除，改用 PowerShell CIM 精确枚举
  # run-tenant/run-supervisor（排除 pm2/MCP 等无关 node 进程）。
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
for TENANT in $TENANT_LIST; do
  rm -f "$RUNTIME_ROOT/$TENANT/locks/"*.lock
done

# 4) 重启 live supervisor（脱离当前会话，日志追加；--record-calibration 旁路
#    只记录 raw Runtime-Golden dataset；后续校准严格离线执行）
cd "$REPO" || exit 1
# 遥测上报：command-center ingest endpoint，租户进程继承
export ARENA_HERO_TELEMETRY_ENDPOINT=http://127.0.0.1:8787/api/ingest/agents
# 主租户身份标签取 ARENA_TENANTS 首项（supervisor 级遥测归属）
export ARENA_HERO_TENANT="${TENANTS_CSV%%,*}"
nohup npm run arena:supervisor -- --data-root="$DATA_ROOT" --configs="$TENANTS_CSV" --mode=deterministic --live --record-calibration --record-alliance-shadow --alliance-shadow-interval-ticks=3 --alliance-director-shadow --alliance-director-period-ticks=4 --alliance-director-max-skew-ticks=2 --port=8120 >> "$SUPERVISOR_LOG" 2>&1 &
echo "$(now) supervisor restarted (pid $!, tenants=$TENANTS_CSV, alliance-shadow=3 director=ASSIST_ONLY/period4/skew2)" >> "$LOG"
# 测绘库增量同步（survey-db 联动）：重启后同步最新 run 的 calibration case
# → 测绘库（幂等；供下次启动 seed + 面板 /api/survey）。
# 只读 calibration + 写 survey 库，与 supervisor 无 writer 冲突。
# 必须显式 --data-root（CLI 默认解析到 worktree 内 data，不存在会静默空跑）。
(cd "$REPO" && npm run survey:sync --silent -- --data-root="$DATA_ROOT" --tenants="$TENANTS_CSV" --latest-only) >> "$LOG" 2>&1 || true
