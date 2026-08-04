# 世界状态管理设计

> 状态：设计稿（2026-08-04）。覆盖本地记忆 vs 服务器权威、地图状态结构、记忆更新/失效、refill 语义与长期记忆边界（对齐 MASTER.md 红线：不提前实现 MapStore worker）。

## 1. 本地记忆 vs 服务器权威

| 信息 | 权威方 | 我们可记忆 | 失效规则 |
|---|---|---|---|
| 永久障碍 | 服务器（secret seed 生成） | ✅ 永久记忆（generation 不变则永久有效） | 世界重置（tick 回退）时全清 |
| 资源节点 | 服务器（动态） | ✅ 缓存（最近可见，2026-08-04 设计定稿） | 被采空（HARVEST 成功 / 后续 state 不再显示）→ 移除；refill 后重新可见 |
| 资源 pile | 服务器（动态） | ✅ 缓存 | 被 harvest 完 → 移除 |
| Champion Beacon | 服务器 | ✅ 坐标永久可见（规则） | 移动时更新 |
| 敌人位置 | 服务器 | ⚠️ 仅当可见（视野内） | 离开视野即过期（不记忆敌人——可能已移动） |
| secret seed / 生成契约 | 服务器 | ❌ 不可得 | — |
| 未探索区域 | — | ✅ 探索状态（巡逻 ring/direction） | 世界重置时全清 |

**设计原则**：本地记忆 = 服务器权威的**只读缓存**，所有记忆更新由可见性/事件驱动，不猜测不可见事实（防"幽灵资源"——记忆中的资源格实际已被其他玩家采走）。

## 2. 当前实现分析（domain/world.ts vs map-store.ts）

- `domain/world.ts`（World 类）：跨 Tick 记忆——障碍集（永久）、资源线索（hints）、Worker 巡逻状态（unitMemory：mode/ring/direction/harvestTarget）。**决策层用**（SafetyPlanner/DeterministicPlanner 持有）。
- `map-store.ts`：MapStore——职责需确认（障碍/资源缓存的结构化存储）。

**观察到的缺口**：
1. 记忆无显式失效路径：资源 hint 被采空后是否移除？（HARVEST_FAILED / 可见性校正）
2. 敌人位置记忆缺失（合理——但 Worker 巡逻规划可能受益于"最后看到敌人方向"）
3. 无世界重置处理：tick 回退时 World 记忆不清空 → 幽灵障碍/资源

## 3. 目标世界状态结构

```ts
interface LocalWorldState {
  /** 永久障碍（generation 内不失效）。 */
  readonly obstacles: ReadonlySet<string>;
  /** 资源节点缓存：cellKey → 最后可见 tick（用于过期判定）。 */
  readonly resourceCache: ReadonlyMap<string, number>;
  /** 资源 pile 缓存（Worker 死亡掉落）。 */
  readonly pileCache: ReadonlyMap<string, number>;
  /** Beacon 已知位置。 */
  beaconPosition: Position | null;
  /** 每个单位的巡逻/任务记忆。 */
  readonly unitMemories: ReadonlyMap<string, UnitMemory>;
  /** 世界版本（tick 单调检测；回退 → 全清）。 */
  lastTickSeen: number | null;
}
```

**更新/失效流程（事件驱动）**：

```
state（每 tick）──► reconcile：
  1. tick 单调检查：tick < lastTickSeen → WORLD_RESET → 全清记忆 + 策略重置
  2. obstacles：state.obstacleCells 并入永久障碍集（只增不减）
  3. resourceCells：可见资源 → resourceCache.set(key, tick)
  4. 失效：可见性覆盖——本 tick 可见的 cell 集合外，resourceCache 中
     lastSeen 超过 N ticks（缺省 64，≈ 4 个 refill 周期）的条目删除
     （该区域若 refill 会重新可见；未 refill 说明被采空）
  5. piles：同 4（pile 消失 → 移除）
  6. events 校正：HARVEST_SUCCESS/WORKER_CARGO_DROPPED 更新 pile；
     HARVEST_FAILED(reason=RESOURCE_DEPLETED) → 移除该格资源缓存
```

## 4. 探索与记忆交互（focusRegion 已接入）

```
MacroPolicy.focusRegion ──► Worker patrol 目标（go_focus，PR #20 已实现）
                                 │
                         巡逻经过新区域
                                 │
                         可见资源/障碍 → 记忆更新
                                 │
                         资源采空/refill → 失效/新增
```

**增强建议**：
- Worker 巡逻方向记忆（patrolDirection）已按单元持久；focusRegion 到达后可切回巡逻（当前 go_focus 是永久直行——应加"到达聚焦区后转巡逻"逻辑）
- 军事单位（Vanguard/Ranger）视野更广（4/5），其巡逻也可贡献资源记忆（当前只有 Worker 巡逻）——可选增强

## 5. refill 语义对记忆的影响

- refill 每 4 tick 确定性发生（服务器），新节点**只在可见时**进入我们的记忆
- 记忆过期窗口（64 ticks）≥ 4 个 refill 周期：若 4 个周期内某格始终不可见/未恢复，视为被采空移除——但**视野外的 refill 我们永远看不到**（服务器不广播），所以过期删除只清理"曾经可见但可能已被采"的条目
- 不猜测：visibleResourceCellCount=0 的生产观察（t1 资源停滞）根因是巡逻覆盖不足而非记忆错误——focusRegion 策略上线后应改善（用 policy.jsonl + outcome.jsonl 数据验证）

## 6. 长期记忆边界（MASTER.md 红线）

- **不做**：跨进程持久化世界记忆（MapStore worker 是明确关闭的路线）
- **做**：进程内 World 记忆 + 世界重置检测（tick 回退全清）
- 理由：服务器是唯一权威；我们每 tick 都有完整可见 state 可重建记忆；持久化增加一致性负担且无净收益

## 7. 实施建议（优先级）

1. **P0**：tick 单调检测 + 世界重置全清（世界状态完整性）
2. **P0**：资源记忆过期（64-tick 窗口移除）——防幽灵资源
3. **P1**：events 校正（HARVEST_FAILED RESOURCE_DEPLETED → 移除缓存）
4. **P1**：go_focus 到达后转巡逻（探索效率）
5. **P2**：军事单位巡逻贡献资源记忆（视野复用）
