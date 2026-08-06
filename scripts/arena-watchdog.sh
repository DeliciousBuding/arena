#!/usr/bin/env bash
# Arena 本地看护（用户授权自主维护，2026-08-06；t3/t4 移交 Rust 线
# 2026-08-07）：每分钟检查本地 supervisor /ready；异常则确认旧进程死透 →
# 清理死锁 → 重启 live supervisor（t1/t2；t3/t4 由 arena-rs 看护，
# 本脚本不得拉起，防双 writer）。日志追加到 ~/arena-watchdog.log。
set -u

LOG="$HOME/arena-watchdog.log"
REPO="/d/Code/Projects/arena/arena-ts"
DATA_ROOT="/d/Code/Projects/arena/data"
RUNTIME_ROOT="$DATA_ROOT/runtime"
READY_URL="http://127.0.0.1:8120/ready"

now() { date '+%Y-%m-%d %H:%M:%S'; }

# 健康则无事。注意：grep 必须取第一个 "ready" 字段（JSON 顶层），
# 否则 tenants 数组内其他租户的 "ready":true 会让子串匹配误判健康
# （2026-08-06 实测：t1 单线 failed 时 watchdog 因此漏恢复）。
READY=$(curl -sS -m 5 "$READY_URL" 2>/dev/null | grep -oE '"ready":(true|false)' | head -1)
if [ "$READY" = '"ready":true' ]; then
  # 第二道健康检查（2026-08-07 t1/t2 同时 stall 事件）：/ready 只证明进程
  # 存活，无法感知"连接半开但 tick 流停更"。outcome JSONL 超过 STALL_MAX_AGE_S
  # 未更新即视为 stall，走下方恢复路径（SDK 侧 idle 超时是主修复，此处兜底）。
  STALL_MAX_AGE_S=600
  STALL_TENANT=""
  for TENANT in t1 t2; do
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
  done
  if [ -z "$STALL_TENANT" ]; then
    exit 0
  fi
  echo "$(now) STALL detected ($STALL_TENANT outcome stale > ${STALL_MAX_AGE_S}s) -> recovering" >> "$LOG"
else
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

# 2) 再确认没有残留 run-tenant / run-supervisor 进程（双 writer 红线）
STRAY=$(wmic process where "name='node.exe'" get processid,commandline 2>/dev/null \
  | grep -E 'run-tenant|run-supervisor' | grep -oE '[0-9]+$' | head -1)
if [ -n "$STRAY" ]; then
  taskkill //PID "$STRAY" //T //F >> "$LOG" 2>&1
  sleep 3
fi

# 3) 清理死锁（进程已确认死透；只清 t1/t2——t3/t4 锁归 Rust 线）
rm -f "$RUNTIME_ROOT/t1/locks/"*.lock "$RUNTIME_ROOT/t2/locks/"*.lock

# 4) 重启 live supervisor（脱离当前会话，日志追加；--record-calibration 旁路
#    只记录 raw Runtime-Golden dataset；后续校准严格离线执行）
cd "$REPO" || exit 1
nohup npm run arena:supervisor -- --data-root="$DATA_ROOT" --configs=t1,t2 --mode=deterministic --live --record-calibration --port=8120 >> "$LOG" 2>&1 &
echo "$(now) supervisor restarted (pid $!)" >> "$LOG"
