# Deadlock Defense v1 — 死锁综合防护设计

状态：2026-08-10 设计定稿（已落地的标注 ✅，待补标注 ⏳）
范围：`arena-agent` 决策层 + `arena-hero-ts` SDK 请求层。
原则：死锁是生存级行为，**优先级高于一切经济/军事配比策略**；数学防死锁
（容量公式）优先于启发式；降级零回归（新参数带默认 = 现状）。

## 0. 死锁分类与根因

| 类 | 根因 | 后果 | 防护层 |
|---|---|---|---|
| L1 资源顶格 | res ≥ Core 容量（max(10, pop×5)）→ DEPOSIT_FAILED | 满载 worker 卡 Core 格，采集-卸货停摆 | P3 硬顶 + yieldDirection |
| L2 容量天花板 | pop ≥ populationCeiling → 所有 SPAWN 分支关闭 | res 囤积 → 触发 L1 | P2 高水位 + P3 硬顶 |
| L3 兑换门槛跌破 | P2 消费后 res < 150 → 无法兑换黑与白 | 失去兑换能力（兑换红线） | P2 花完仍 ≥150 门 ✅ |
| L4 通道占用 | 军事/满载 worker 站 Core 格 → SPAWN/DEPOSIT 被拒 | 同 tick 经济停摆 | core-clearance + yieldDirection |
| L5 迁移交仓 | Core MOVING 时 DEPOSIT 被引擎拒（CORE_MOVING） | cargo worker 追移动核心空跑 | core-moving-hold 变体 |
| L6 产兵成本 | 动态定价 pop≥21 后成本涨，固定价预算 → INSUFFICIENT | 连串 SPAWN_FAILED | unitSpawnCosts 动态价 ✅ |
| L7 WS stall | 连接半开但 tick 流停更（进程 alive） | watchdog /ready 都看不到 | idleTimeoutMs 消息级 ✅ |
| L8 重连风暴 | 4 租户同刻重连撞 CF | IP 评分下降 / 临时封 | full jitter + 错峰 ⏳ |
| L9 CF 质询 | 403+cf-mitigated → 狂撞加速封禁 | 永久失去 API | 质询检测 + 冷却 ⏳ |

## 1. 四层产兵优先级（L1/L2/L3 防护，已落地 ✅）

```
P0 生存动作（HEAL/REPAIR/迁移/取消）      —— Safety 裁决透传
P1 军事危机爆兵                            —— 无视 reserve/水位/ceiling
   military < 8（4V+4R）且 workers ≥ 4（起步门）
   或 coreThreatened 且 V < 3              —— 可跌破 150（危机豁免）
P2 资源高水位消费                          —— 花完仍 ≥150 才花（兑换门槛硬约束）
   res ≥ 150 且 res - cost ≥ 150           —— 不破兑换门槛
P3 容量硬顶                                —— 无视兑换门槛（死锁绝对防线）
   res ≥ max(10, pop×5) - 15               —— 可跌破 150（防 DEPOSIT_FAILED）
P4 正常策略（surge/威胁/补员/军事配比）     —— 完全保留历史行为
```

**优先级裁决**：P1 > P3 > P2 > P4。P1（危机）和 P3（死锁）是"可破门槛"的
两类豁免；P2 和 P4 不得让 res 跌破 150（兑换红线"随时可兑换黑与白"）。

## 2. 通道死锁防护（L4，已落地 ✅）

- `yieldDirection`：满载 worker 资源满时让出 Core 格（Core 四邻首个非障碍格）；
  DEPOSIT 不合法时原地 WAIT 会永久占 Core 格 → SPAWN 被拒 → 资源永不消耗 →
  永远满；让位后 SPAWN 消耗资源、卸货通道恢复。
- `core-clearance-v1` 变体：军事绝不站 Core 格（守位回退外圈 Chebyshev 2）；
  已在 Core 格的军事/满载 worker 自动疏散让位。
- `resolveMoveCapacity`：单格容量 2 预裁决，超容量格淘汰最低优先级到达动作，
  保留合法依赖链（不把"本 tick 会离开"的格误判成永久墙）。

## 3. 迁移交仓死锁（L5，变体级）

- `core-moving-hold-v1`：Core MOVING 时 cargo worker 原地持货等核心稳定，
  不追移动核心空跑（t2/t3 手操迁移 150 tick 内 DEPOSIT_FAILED 17/11 次实证）。
- 与 `core-clearance-v1` 互补：一个管迁移中不追交、一个管不堵核心格。

## 4. SDK 请求层死锁（L7/L8/L9，见 network-resilience-v1.md）

- L7 WS stall：`idleTimeoutMs=120000` 消息级兜底（连接半开但零数据 → 强制
  断开走重连）；2026-08-07 t1/t2 同时 stall 事件根因修复。✅
- L8 重连风暴：full jitter + 错峰启动（4 租户不同刻握手）。⏳
- L9 CF 质询：403+cf-mitigated 检测 → 冷却 60s 不重试 + 遥测标记。⏳

## 5. 经济停滞告警（运行时巡检，已落地 ✅）

- `STALL_WARNING_TICKS=16`：连续 16 tick 满载 worker 无法回仓（delta=0 +
  cargoTot>0）即告警——t1 容量死锁 60+ tick 才被人工发现的教训。
- watchdog 巡检：进程 alive 但 tick 流停更（L7）+ 经济停滞（L1/L4）双维度。

## 6. 兑换门槛硬约束（L3，2026-08-10 落地 ✅）

资源池维护标准：**t1 平时 res ≥ 150（黑与白公益站注册码商店实测价）**，
随时可兑换；只有 P1 危机 / P3 死锁允许跌破。

- P2 高水位消费加"花完仍 ≥150"门：`res - spawnCosts[unitType] ≥ 150` 才花，
  否则保留资源等下 tick 攒够（不破兑换能力）。
- 正常补员（Worker cost 5）天然不破门槛（res < 155 时也产不起 5+reserve）。
- P1/P3 豁免（生存 > 兑换）。
- 商店价格动态源：`data/shop/` 快照（shop-price-intel.py 拉取）→ 高水位
  随商店最高价刷新（当前 150，商店涨价自动跟）。

## 7. 待补项（⏳）

1. **L8/L9 SDK 实现**（network-resilience-v1 §2.2/2.3）：full jitter + CF 检测；
2. **兑换动作自动化**（待用户裁决）：当前 agent 只维持 res≥150，兑换动作
   由用户手动；未来是否 agent 自动调 linuxdoshop 兑换 API（需登录态/密钥）？
3. **P2 动态军事成本感知**：当前 P2 用 unitSpawnCosts（动态价）已对，但
   "花完仍 ≥150"在高人口段（pop≥21 成本涨）会让 P2 更难触发——这是正确的
   （高人口段 res 难攒到 150+cost），不需额外处理。

## 8. 验收

- 单元测试：deterministic-planner.test.ts P2 用例验证"花完仍 ≥150"门
  （res 165 + Ranger 45 → 120 < 150 不花；res 200 + Ranger 45 → 155 ≥ 150 花）；
- 生产验证：t1 runtime.jsonl 观察 res 是否常驻 150-185 区间（够兑换 + 不顶满）；
- 死锁回归：t1 不再出现 pop≥ceiling 后 DEPOSIT_FAILED 连串（P3 兜底）。
