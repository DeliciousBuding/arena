#!/usr/bin/env bash
# 决策停摆检测（2026-08-07 t2 实证后新增）：进程/outcome 均健康但策略
# 0 动作（agentActionCount==0 且 moveCount==0 持续）→ 经济停摆。
# t2 事件：8 workers 全带 cargo、资源恒 3、>600 tick 决策全 WAIT——
# outcome.jsonl 每 tick 照常落盘（tick 推进正常），watchdog 原有
# outcome stall 检测（10 分钟无更新）漏检。本脚本检查 decision
# telemetry 的"动作活跃度"，供 arena-watchdog.sh 集成。
#
# 用法：check-decision-stall.sh <data-root> <tenant> [inactive-ticks=120]
# 输出：STALL:<tenant>（判定停摆）/ OK:<tenant>
# 判定：decision.jsonl 最后 N 行 agentActionCount 与 moveCount 全为 0。
#   注意合法场景（t1 资源枯竭巡逻）moveCount>0，不会误报；"全单位
#   无可行动作"是死锁特征（修复前 t2 每 tick 全 WAIT 恒真）。
set -u

DATA_ROOT="$1"
TENANT="$2"
INACTIVE_TICKS="${3:-120}"
DECISION="$DATA_ROOT/runtime/$TENANT/telemetry/decision.jsonl"

if [ ! -f "$DECISION" ]; then
  echo "OK:$TENANT"  # 尚无 decision 遥测（新 run 宽限）
  exit 0
fi

LAST=$(tail -n "$INACTIVE_TICKS" "$DECISION")
if [ -z "$LAST" ]; then
  echo "OK:$TENANT"
  exit 0
fi

# agentActionCount 与 moveCount 逐行提取；任一 >0 即活跃
ACTIVE=$(echo "$LAST"   | grep -oE '"agentActionCount":[0-9]+|"moveCount":[0-9]+'   | sed 's/.*://'   | awk '$1 > 0 { print 1; exit }')
if [ -n "$ACTIVE" ]; then
  echo "OK:$TENANT"
  exit 0
fi
# 低人口发育期豁免（2026-08-08，t4 贫矿 2-worker 实证）：worker<3 且持续 0 动作
# = 发育期爬坡（贫矿/远矿，执行受阻），不是"决策停摆"——watchdog 重启不解决
# 贫矿/慢发育，反而每分钟循环杀全租户（13:15-13:21 实证 7 连重启，t1 迁移被打断）。
# 满载卸货死锁由 check-economy-stall.sh 独立捕获（不受本豁免影响）。
OUTCOME="$DATA_ROOT/runtime/$TENANT/telemetry/outcome.jsonl"
if [ -f "$OUTCOME" ]; then
  WORKERS=$(tail -n 5 "$OUTCOME" | grep -oE '"workerCount":[0-9]+' | tail -1 | sed 's/.*://')
  WORKERS="${WORKERS:-99}"
  if [ "$WORKERS" -lt 3 ]; then
    echo "OK:$TENANT"  # 低人口发育期（<3 worker）：重启无效，豁免决策停摆
    exit 0
  fi
fi
# 死区/贫矿豁免（2026-08-08，t4 死区实证）：worker>=3 探矿（GO_RESOURCE 意图）
# 但视野持续 0 新鲜资源（outcome visibleResourceCellCount==0）→ 地理性停滞，
# 不是决策死锁（无矿可采，重启不能解决，反而每分钟杀全租户——13:26-13:38 13
# 连、15:03-15:07 5 连重启实证）。与"满载持货死锁"（economy-stall 独立捕获）
# 互补：探矿无果豁免，持货不交不豁免。
OUTCOME="$DATA_ROOT/runtime/$TENANT/telemetry/outcome.jsonl"
if [ -f "$OUTCOME" ]; then
  VIS0=$(tail -n 40 "$OUTCOME" | grep -c '"visibleResourceCellCount":0')
  VIS_TOTAL=$(tail -n 40 "$OUTCOME" | grep -c '"visibleResourceCellCount"')
  HAS_GO=$(echo "$LAST" | grep -c '"GO_RESOURCE":[1-9]')
  # 需要同时满足：探矿意图存在 + 视野记录充足 + 40 行全 0 可见资源
  if [ "$HAS_GO" -gt 0 ] && [ "$VIS_TOTAL" -gt 0 ] && [ "$VIS0" = "$VIS_TOTAL" ]; then
    echo "OK:$TENANT"  # 死区/贫矿探矿：视野无资源可采，重启无效
    exit 0
  fi
fi


# 0 人口豁免（2026-08-08，t4 死经济实证）：全租户无单位时 intentCounts 为空
# （{}）——0 动作是合法的（没有单位可命令），不是"决策停摆"（停摆指有单位
# 却全 WAIT）。否则看护把 t4 死经济当 STALL → 恢复重启 → 仍 0 单位 → 无限
# 重启循环（11:45-11:48 实证连环重启，411 次累计）。
INTENT_EMPTY=$(echo "$LAST" | grep -c '"intentCounts":{}')
INTENT_TOTAL=$(echo "$LAST" | grep -c '"intentCounts"')
if [ "$INTENT_TOTAL" -gt 0 ] && [ "$INTENT_EMPTY" = "$INTENT_TOTAL" ]; then
  echo "OK:$TENANT"
  exit 0
fi
echo "STALL:$TENANT"
