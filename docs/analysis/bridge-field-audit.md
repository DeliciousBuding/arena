# 桥状态投影字段审计（R2，2026-08-09）

## 背景
性能测量（perf-optimization-2026-08-09.md）：1000 tick 流水线模式 avg_tick=50.3ms，
prefetch 52%（观察+状态 JSON 序列化+桥提交）。桥状态投影 = 只序列化 agent 决策
所需字段的非空值（省略恒 null 的可选字段），减少序列化体积与解析开销。

## 审计方法
对 5 个 Python agent（python-agents.json 注册名）的决策代码做静态枚举：
读取的 PlayerState 字段（state.* 与嵌套 objects[] 的 UnitView/CoreView/Beacon 字段）
全部可静态枚举（无按名反射/遍历全字段的动态读取）。

## 白名单（BRIDGE_PROJECTION_AUDITED_AGENTS，全量无降级）
farmer / core / waaiging / tactic / arena-evolve —— 全部通过静态枚举审计。

## 投影规则（protocol-bridge.ts TickStateToProtoOptions.projectFields）
只省略**恒 null 的可选字段**（桥端 pydantic 默认 None 还原——agent 看到的
值不变：null → None），其余字段原样序列化：

| 字段 | 投影行为 | 依据 |
|---|---|---|
| CoreView.move_direction/move_progress/move_required_ticks/destination | NORMAL 时省略（恒 null）；**MOVING 必须全带** | 官方 wire 校验 |
| UnitView.cargo | 省略 null（仅受控 WORKER 有值） | 恒 null 省略 |
| ChampionBeacon.status/carrier_id | 省略 null；**CARRIED 时 carrier_id 恒有值** | 官方 wire 校验 |
| PlayerState.respawn_at_tick | 仅 ACTIVE 且 null 时省略；**RESPAWNING 必须带** | 官方 wire 校验 |
| ResolutionEvent 可选字段 | 省略 null | 恒 null 省略 |

## 验证（总负责人验收，2026-08-09）
1. **一致性 PASS**：同 seed 同场景（dense radius 18，6 玩家 300 tick）投影关 vs 开：
   events 5760 = 5760，perPlayerLedgers/kills 逐字段全同（探针
   tmp-probe-projection.mts，一次性不入库）。
2. **体积收益**：2 玩家 100 tick（ARENA_BRIDGE_TIMING=1）reqBytes 均值
   1123 → 895 = **-20.3%**（序列化体积压缩 1/5）。
3. **端到端预估**：序列化是 prefetch（52%）的一部分——投影后整体端到端预计
   -5~10%（未做全量复测，标注为预估）。

## 使用
- `runFreeForAll(..., { bridgeProjection: true })` 开启（默认关 = 现状逐字节一致）。
- 只对白名单 agent 生效（未审计第三方/HTTP 端点不投影——tournament.ts 逐 provider
  instanceof OpponentAdapter + 白名单判断）。
- 评测 CLI（run-arena-report）未接线开关（默认关 = 行为不变）；接线时加
  `--bridge-projection` 透传 runFreeForAll。

## 遗留
- 新增 Python agent 必须过字段审计才能进白名单（registry 注册时检查）。
- 完整 15 场评测投影开 vs 关的端到端 wall-clock 对比未跑（预估 -5~10%）。
