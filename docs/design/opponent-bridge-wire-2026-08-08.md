# 模拟器 ↔ 官方协议对接打通 + vs-farmer 对标矩阵（2026-08-08）

## 背景

对抗测试平台（`src/sim/opponent/`）的三层骨架此前已落地：protocol-bridge（中立协议
翻译）、opponent-adapter（对手适配）、tournament（批量矩阵）。但存在四个硬断点：

1. **旧链路失效**：`src/sim/bridge/official-state.ts` 输出 `population_tier`/
   `upkeep_next_tick` 字段——官方 pydantic `extra="forbid"` 实测拒绝（exit 1），
   旧 ExternalPlanner 链路实际已坏；
2. **协议层 ID 未适配**：`tickStateToProto` 直传模拟器事件 ID（`sim:...` 格式），
   官方要求 `id: UUID`（UnitView/CoreView/ResolutionEvent/beacon carrier 全校验）；
3. **owner_username 不符合官方 pattern**：官方要求 `^[a-z0-9_]+$` 且长度 ≥3，
   模拟器 `player-a` 会被 pydantic 拒绝；
4. **ReferenceSubprocessDecider 是空壳**：decide() 直接返回空 plan；
   `tournament-run.mts` import 已删除的旧路径。

## 修复内容

### `src/sim/opponent/protocol-bridge.ts`
- 新增 `toDeterministicUuid(id)`：FNV-1a 64 位 → 合法 UUID（v5 风格布局），
  事件 ID（`sim:...`）/actor/target/beacon carrier 全量确定性转换；
- 新增 `normalizeOwnerUsername(name)`：非法字符 → `_`，不足 3 位补 `_`；
- `tickStateToProto` 全对象 ID/username 适配。

### `scripts/opponent-bridge.py`
- 新增 `--state-slot <path>`：CoreFarmer.__dict__ pickle 到磁盘槽，每次启动恢复、
  决策后存回——"随用随起"（每 tick spawnSync 新进程）也能跨 tick 保留记忆；
- 槽损坏自动降级（不阻断对局），槽写失败降级为无记忆。

### `src/sim/opponent/opponent-adapter.ts`
- `ReferenceSubprocessDecider` 真实现：spawnSync `opponent-bridge.py --one-shot
  --state-slot`，输入官方 PlayerState JSON、读回官方 CommandPlan JSON；
- 默认 state-slot 在 `os.tmpdir()` 下随机名，`close()` 自动清理（默认槽）；
- bridgeScript 按 `import.meta.url` 相对定位（`../../../scripts/`）。

### `src/sim/opponent/tournament.ts`
- `makeArenaScenario` 加 seed 参数：资源盘从 6 个变体确定性选取（同 seed 恒同场景）；
- `runMatch` 场景升级：双方 3 初始 worker + 25 资源 + refill（65 ticks 近似），
  对局能发育、有区分度。

### 脚本/测试
- `scripts/tournament-run.mts`：import 修复 → `src/sim/opponent/tournament.ts`；
- `scripts/vs-farmer.mts`（重建）：我方 SafetyPlanner(agg) vs arena_farmer，
  8 seeds × 200 ticks 端到端矩阵；
- `test/protocol-bridge.test.ts`：+事件 UUID 适配 / toDeterministicUuid /
  normalizeOwnerUsername 测试；
- `test/tournament.test.ts`（新增）：seed 变体确定性、初始单位 UUID、
  decideWinner 优先级。

## 验证

1. **协议全链路**：`tickStateToProto` 输出 → 官方 pydantic `PlayerState.model_validate`
   → `CoreFarmer.choose_actions` → 官方 `CommandPlan` → `protoPlanToPlan`，一次通过
   （旧链路同输入 exit 1）；
2. **state-slot 记忆**：两次独立 `--one-shot` 调用，槽文件生成（1685B）且跨进程
   恢复正常；
3. **测试**：protocol-bridge 6/6、tournament 4/4 全绿；`tsc --noEmit` 干净；
4. **端到端矩阵**：`vs-farmer.mts` 8 seeds 完整跑通（551s），无崩溃。

## vs-farmer 对标结果（v0.14 规则，200 ticks × 8 seeds）

```
我的胜率=62.5% (5/8)  farmer 胜率=37.5% (3/8)  平局=0
我 均资源=3.6  farmer 均资源=1.6
```

| seed | 胜者 | 我(资源/人口) | farmer(资源/人口) | events |
|---|---|---|---|---|
| 1 | 我 | 5/7 | 0/6 | 2107 |
| 2 | farmer | 2/8 | 3/5 | 2130 |
| 3 | 我 | 5/7 | 2/6 | 2166 |
| 4 | 我 | 4/7 | 1/5 | 1883 |
| 5 | farmer | 1/8 | 2/6 | 2169 |
| 6 | 我 | 5/7 | 2/5 | 2098 |
| 7 | 我 | 5/7 | 0/6 | 2105 |
| 8 | farmer | 2/8 | 3/5 | 2129 |

**信号**：farmer 赢的 3 局（seed 2/5/8）中我方案略人口反而更高（8 vs 5-6）但资源
被榨干（1-2）——aggressive 过度产兵、资源判负。这是平台第一个真实对标信号：
我方军事前压策略在部分资源布局下存在"过度扩张"风险，后续可针对性地做资源守恒
校准（如 lean-spend / spawnReserve 再评估）。

## 生产隔离复核

- 平台代码全部位于 `src/sim/opponent/`（独立命名空间），生产 v3 worktree 无引用；
- state-slot 默认在 `os.tmpdir()`，对局结束自动 unlink；子进程零网络端口；
- 官方 SDK/reference 仓库只读注入 `sys.path`，零改动。
