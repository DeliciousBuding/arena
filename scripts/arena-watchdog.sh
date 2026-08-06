#!/usr/bin/env bash
# Arena 本地看护（用户授权自主维护，2026-08-06）：
# 每分钟检查本地 supervisor /ready；异常则确认旧进程死透 → 清理死锁 →
# 重启 live supervisor（t1/t2/t3/t4）。日志追加到 ~/arena-watchdog.log。
set -u

LOG="$HOME/arena-watchdog.log"
REPO="/d/Code/Projects/arena/arena-ts"
DATA_ROOT="/d/Code/Projects/arena/data"
RUNTIME_ROOT="$DATA_ROOT/runtime"
READY_URL="http://127.0.0.1:8120/ready"

now() { date '+%Y-%m-%d %H:%M:%S'; }

# 健康则无事
if curl -sS -m 5 "$READY_URL" 2>/dev/null | grep -q '"ready":true'; then
  exit 0
fi

echo "$(now) NOT ready -> recovering" >> "$LOG"

# 1) 若 8120 还有监听（supervisor 半死），按端口强杀整个进程树
PID=$(netstat -ano 2>/dev/null | grep ':8120' | grep -i LISTEN | head -1 | awk '{print $NF}')
if [ -n "$PID" ]; then
  taskkill //PID "$PID" //T //F >> "$LOG" 2>&1
  sleep 3
fi

# 2) 再确认没有残留 run-tenant / run-supervisor 进程（双 writer 红线）
STRAY=$(wmic process where "name='node.exe'" get processid,commandline 2>/dev/null \
  | grep -E 'run-tenant|run-supervisor' | grep -oE '[0-9]+$' | head -1)
if [ -n "$STRAY" ]; then
  taskkill //PID "$STRAY" //T //F >> "$LOG" 2>&1
  sleep 3
fi

# 3) 清理死锁（进程已确认死透）
rm -f "$RUNTIME_ROOT/t1/locks/"*.lock "$RUNTIME_ROOT/t2/locks/"*.lock \
  "$RUNTIME_ROOT/t3/locks/"*.lock "$RUNTIME_ROOT/t4/locks/"*.lock

# 4) 重启 live supervisor（脱离当前会话，日志追加；--record-calibration 旁路
#    只记录 raw Runtime-Golden dataset；后续校准严格离线执行）
cd "$REPO" || exit 1
nohup npm run arena:supervisor -- --data-root="$DATA_ROOT" --configs=t1,t2,t3,t4 --mode=deterministic --live --record-calibration --port=8120 >> "$LOG" 2>&1 &
echo "$(now) supervisor restarted (pid $!)" >> "$LOG"
