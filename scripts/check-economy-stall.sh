#!/usr/bin/env bash
# 经济停摆检测（2026-08-08 t1/t2/t3 复盘后新增）：进程/决策均活跃但经济零产出——
# "假活"冻结。场景：满载 worker ≥2 持货却持续 0 卸货（交仓通道被占/上不了核心格，
# t1 1214 tick、t2 2950 tick 全队 WAIT 冻结实证）；决策侧 moveCount>0（单位在动），
# check-decision-stall.sh 的"0 动作"判定查不到这种冻结。
#
# 判定（outcome.jsonl 最近 N 行）：max(workersWithCargo)>=2 且 DEPOSIT_SUCCEEDED
# 事件数==0 且 coreResourceDelta 总和==0 且窗口内无 CORE_RESOURCE_FULL /
# CORE_MOVING / CORE_NOT_PRESENT 失败（容量锁/迁移期是合法 0 卸货，不误报）。
#
# 用法：check-economy-stall.sh <data-root> <tenant> [window-ticks=60]
# 输出：STALL:<tenant> / OK:<tenant>
set -u

DATA_ROOT="$1"
TENANT="$2"
WINDOW="${3:-60}"
OUTCOME="$DATA_ROOT/runtime/$TENANT/telemetry/outcome.jsonl"

if [ ! -f "$OUTCOME" ]; then
  echo "OK:$TENANT"  # 尚无 outcome 遥测（新 run 宽限）
  exit 0
fi

LAST=$(tail -n "$WINDOW" "$OUTCOME")
if [ -z "$LAST" ]; then
  echo "OK:$TENANT"
  exit 0
fi

MAX_CARGO=$(echo "$LAST" | grep -oE '"workersWithCargo":[0-9]+' | sed 's/.*://' | sort -n | tail -1)
MAX_CARGO="${MAX_CARGO:-0}"

DEPOSITS=$(echo "$LAST" | grep -oE '"DEPOSIT_SUCCEEDED"' | wc -l)
DELTA=$(echo "$LAST" | grep -oE '"coreResourceDelta":-?[0-9.]+' | sed 's/.*://' | awk '{s+=$1} END{print s+0}')

# 合法 0 卸货保护：容量满 / 核心迁移中 / 核心不在场 = 卸货本来就会失败，不视为停摆
LOCKED=$(echo "$LAST" | grep -oE '"reasonCode":"(CORE_RESOURCE_FULL|CORE_MOVING|CORE_NOT_PRESENT)"' | wc -l)

if [ "$MAX_CARGO" -ge 2 ] && [ "$DEPOSITS" -eq 0 ] && [ "${DELTA%.*}" -eq 0 ] && [ "$LOCKED" -eq 0 ]; then
  echo "STALL:$TENANT"
else
  echo "OK:$TENANT"
fi
