# 游戏逻辑状态机设计

> 状态：设计稿（2026-08-04）。覆盖 Core 复活/摧毁、Unit 生命周期、规则升级/重置、资源状态机，及我们 sim 的覆盖矩阵与决策层集成点。

## 1. 玩家/Core 生命周期状态机

```
                     combat 摧毁（敌人攻击致死）
                     SELF_DESTRUCT（v0.12 自毁，无条件）
                     upkeep 摧毁（deficit 超过保护数）
                        │
   ACTIVE ──────────────┼──────────────► RESPAWNING
     │  ▲                                │  │
     │  │ respawn 成功                   │  │ respawnAtTick = 当前 tick
     │  │ （P12 放置新 Core）            │  │ （同 Tick 立即尝试）
     │  └───────────────────────────────┘  │
     │                                     │ respawn 失败（目标格被占/无敌方 Core 参照）
     │                                     ▼
     │                              RESPAWNING（延迟重试）
     │                              respawnAtTick = 下一 tick
     └─────────────────────────────────────────────────►
```

**转移表**：

| 转移 | 触发 | 条件 | 效果 | 事件 |
|---|---|---|---|---|
| ACTIVE → RESPAWNING | combat 摧毁 | Core HP ≤ 0 且敌人伤害 ≥ HP+盾 | 资源捕获（v0.9：转移给最高伤害攻击者）、库存销毁、舰队移除、beacon 掉落 | `CORE_DESTROYED`(reason=ATTACK) + `CORE_RESOURCE_TRANSFERRED` |
| ACTIVE → RESPAWNING | SELF_DESTRUCT | Core 存活即可（无条件） | 库存/舰队销毁、无捕获、无 loot、beacon 掉落 | `CORE_DESTROYED`(reason=SELF_DESTRUCT) |
| ACTIVE → RESPAWNING | upkeep deficit | ~~资源不足以支付 upkeep~~ **v0.11+ 已消灭**（见下） | — | — |
| RESPAWNING → ACTIVE | P12 respawn | respawnAtTick 到达且合法放置格存在 | 新 Core（新 UUID）、默认 HP/盾、respawn 起始单位 | `CORE_RESPAWNED` |
| RESPAWNING → RESPAWNING | respawn 延迟 | 放置格被占/无可选格 | respawnAtTick += 1 | `RESPAWN_DELAYED` |

**关键规则（2026-08-04 与上游 game-rules.md 核对，§9 + v0.12）**：
- respawn 放置：距相邻活 Core 20-30 Manhattan 的合法格（确定性选择）
- respawn 起始：1 Worker + Core 满血满盾；**起始资源 = 5**
- SELF_DESTRUCT 摧毁走**正常 respawn 流**（同 Tick）

**补充研究结论（2026-08-05 只读核对）**：
- **upkeep 不会摧毁 Core（v0.11+）**：deficit 缺口只伤害 excess units（近 Core 19 保护），`deficitDamage.status = PENDING-VERIFICATION` 且结算打 rule-assumption unknown——ACTIVE→RESPAWNING 只有 combat 与 SELF_DESTRUCT 两条活路径。
- **无重生冷却**：combat/SELF_DESTRUCT 均同 Tick 完成放置（失败才 RESPAWN_DELAYED → tick+1 重试）；裸 RESPAWNING 外部快照 fail-closed 标 unsupported。
- **rulesVersion 滞后于行为**：manifest 仍是 rules-v0.11.json，但代码已实现 v0.12/v0.13 行为（combat.ts 注释还标 v0.12 属标注漂移）——`rulesVersion` 不能单独当行为基线。
- **世界重置审计**（4 项建议）：tick 连续性校验（已实施：#23 World.observe 回退全清）、"永久障碍契约被打破"检测、`CORE_DESTROYED`+`CORE_RESPAWNED` 事件配对显式 onCoreCycle 钩子、新 Core 位置锚定 patrol。

## 2. 规则升级/重置语义（v0.11 → v0.12 → v0.13）

| 版本 | 变更 | 迁移语义 | 我们 sim 处理 |
|---|---|---|---|
| v0.12 | Core SELF_DESTRUCT 无条件化 | 世界/玩家状态保留，仅规则元数据升级 | P02 新增 Core 自毁分支（PR #12，已实现） |
| v0.13 | SHOOT.target_id 可选（cell fire） | 同上 | combat cell-fire 结算（PR #11，已实现） |
| 未来 | （未知） | OPEN/COMMITTED 边界升级；LOCKED/RESOLVING tick 用旧规则结算 | 规则 manifest 版本化（rules-v0.11.json），升级需新 manifest + 契约测试 |

**设计原则**：
- 规则版本是 manifest 字段（`rulesVersion`），所有 sim 数值从 manifest 读取（不硬编码）
- 迁移边界：只允许在 `OPEN`/`COMMITTED` 状态升级（tick 结算中不允许换规则）
- 新版本上线流程：新 rules manifest + 契约测试（rules-manifest.test.ts）→ 本地 replay 验证 → 部署
- **服务器世界重置**（若上游发生）：我们无法阻止，但决策层必须能感知——通过 `tick` 回退或 `events` 异常检测（新增监控：tick 非单调递增即告警并重置本地 World 记忆）

## 3. Unit 生命周期

```
                    spawn（Core SPAWN，5/10/12 资源）
                         │
                   ┌─────▼─────┐
                   │  ALIVE    │
                   └─────┬─────┘
      ┌──────────┬───────┼───────┬──────────┐
      │ MOVE     │ HARVEST/DEPOSIT │ SWEEP/SHOOT │ HEAL（战后同格 Core）
      ▼          ▼            ▼            ▼
  移动/容量裁决    cargo 0↔N    伤害累计      HP 恢复（1 资源/HP）
                         │
              combat 致命伤害 / SELF_DESTRUCT / upkeep deficit
                         │
                   ┌─────▼─────┐
                   │  DEAD     │
                   └───────────┘
   Worker 死亡：cargo → 地面 pile（持久，优先于自然节点回收）
   Beacon 携带者死亡：beacon → 落地（本 tick 不可拾取）
```

## 4. 资源状态机

```
        refill（每 4 tick，确定性伪随机）
             ▲
             │ quota(cx,cy) = max(2, floor(16*8/(8+ring)))
   ┌─────────┴─────────┐
   │   RESOURCE NODE   │
   └─────────┬─────────┘
             │ harvest 成功（1 个 Worker，Beacon 2x）
             ▼
   ┌─────────────────┐   Worker 死亡携带 cargo
   │  EMPTY / PILE   │◄───────────────────┐
   └─────────────────┘   pile 被 harvest   │
             ▲                             │
             └─────────────────────────────┘
```

- 节点移除是即时的（harvest 时）；refill 只在 4-tick 边界
- pile 不占 quota；pile 优先于自然节点被回收
- 我们侧记忆：节点 → EMPTY 需要可见性确认（HARVEST_FAILED 或后续 state 校正）

## 5. 我们 sim 覆盖矩阵

| 状态机 | 已实现（测试证据） | 缺失/待验证 |
|---|---|---|
| Core combat 摧毁 + 资源捕获 | sim-combat.test.ts / sim-settlement.test.ts | 捕获金额与最高伤害者判定专项（MASTER #4） |
| Core SELF_DESTRUCT | sim-settlement.test.ts（v0.12 两用例） | 生产触发（策略层可输出 SELF_DESTRUCT？当前不输出——安全） |
| Respawn 同 Tick/延迟 | sim-respawn.test.ts | respawn 放置确定性 vs 服务器（unknown 边界，MASTER #4） |
| Unit combat 死亡/掉落 | sim-combat.test.ts / sim-economy.test.ts | pile 回收顺序专项 |
| Upkeep deficit | sim-economy.test.ts | deficit 语义 PENDING-VERIFICATION（unknown 标记已有） |
| 资源 refill | sim-economy.test.ts（unknown 记录） | refill 坐标确定性（服务器私有 seed，保持 unknown） |
| 规则升级迁移 | rules-manifest.test.ts | 新版本上线演练 |

## 6. 决策层集成点（升级/重置/复活的应对）

1. **Core 被摧毁（我们被团灭）**：状态里 `status=RESPAWNING` / `core=null` → 策略应重置为 harvest（重建经济）：
   - 实现：MacroPolicyOrchestrator 检测 `state.status === "RESPAWNING"` 或 `core === null` → 强制注入 harvest 策略（覆盖 sticky 的 aggressive）
   - 新增 `respawnOverride`：RESPAWNING 期间 posture 锁定 harvest，恢复 ACTIVE 且 pop ≥ 3 后释放
2. **服务器世界重置检测**：tick 非单调（回退）→ 清空本地 World 记忆 + 策略重置为默认 + 告警 telemetry
3. **规则升级感知**：rulesVersion 变化（state 或 manifest）→ 决策层日志记录 + 可选重新校准
4. **SELF_DESTRUCT 策略用途**（激进防守）：被围攻无望时自毁保资源（不给敌人捕获）——当前策略层不输出 SELF_DESTRUCT（安全边界），作为后续实验项

## 7. 实施建议（优先级）

1. **P0**：respawnOverride（Core 被摧毁 → 策略重置 harvest）——直接影响生产存活
2. **P0**：世界重置检测（tick 回退告警 + 记忆清空）——数据完整性
3. **P1**：SELF_DESTRUCT 策略实验（需要 A/B 证据）
4. **P1**：规则升级演练（新 manifest + replay）
