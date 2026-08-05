# 08 决策指挥设计（Command & Control）

> 目标：解决"局部状态机只优化单点"的问题——单一 worker 任务状态机
> （IDLE→TO_RESOURCE→HARVEST→RETURN→DEPOSIT）无法处理全局停滞
> （资源枯竭、集体互踩、探索无效）。引入**决策指挥分层**：
> 指挥层（全局态势 → 模式）→ 战术层（模式内任务）→ 执行层（提交/遥测）。

## 1. 分层架构

```
┌────────────────────────────────────────────────┐
│ Commander（指挥层，跨 tick，internal/strategy）    │
│  输入：全局指标——资源/工人/可见资源格/停滞计数     │
│  输出：Directive{Mode, Focus}                    │
│  模式：GROWTH → EXPLORE_STARVED → MIGRATE_CAND   │
└──────────────────┬─────────────────────────────┘
                   │ Directive（每 tick）
┌──────────────────▼─────────────────────────────┐
│ Planner（战术层，per tick，internal/strategy）    │
│  按 Directive 调整：巡逻目标/半径/焦点/让位        │
│  停滞跳出：单位位置指纹连续不变 → 强制换目标        │
└──────────────────┬─────────────────────────────┘
                   │ Plan
┌──────────────────▼─────────────────────────────┐
│ Loop（执行层，internal/runtime）                  │
│  exactly-once / submit / outcome 遥测            │
│  全局经济停滞事件（30 tick 无进展）                │
└────────────────────────────────────────────────┘
```

## 2. 模式定义

| 模式 | 触发条件（确定性） | 行为 |
|---|---|---|
| `GROWTH` | 默认；资源增长或工人增长或可见资源格存在 | 现状：分配/巡逻/让位/SPAWN |
| `EXPLORE_STARVED` | 连续 30 tick：资源未增 + 工人未增 + 零可见资源格 | 所有 worker 朝 Beacon 方位集中扫掠（半径 16→32→64 环扩展，同方向错开半径成扫掠线） |
| `MIGRATE_CAND` | EXPLORE_STARVED 持续 100 tick（≈4 补给周期无收获） | 产出迁移候选（事件+遥测，**不自动执行**：START_MOVE 需显式确认，红线：迁移是重大动作） |

## 3. 停滞跳出机制（战术层）

两类停滞，两种跳出：

| 停滞 | 检测 | 跳出 |
|---|---|---|
| 本地无路（BFS 失败） | moveToward 返回 WAIT | 换下一个巡逻目标（已有） |
| **服务器不结算**（计划有效但位置不变：拥挤/被占） | **单位位置指纹**（state 中位置连续 3 tick 不变且单位有 MOVE 意图） | 强制换巡逻目标 + 重置指纹 |

第二类是本轮新增核心：**位置来自服务器反馈**，天然反映"结算是否生效"。
即使计划每 tick 都合法（BFS 有路、validator 通过），服务器不结算
（如目标格被静止单位占、结算冲突）也能在 3 tick 内被检测并跳出。

## 4. 状态机完善（worker 行为状态）

经济循环状态机（跨 tick，由"行为 + 位置 + cargo"推导，不新增持久状态）：

```
IDLE ──to_resource──▶ TO_RESOURCE ──到达──▶ HARVEST ──cargo=1──▶ RETURN
 ▲                                                              │
 └──────────────IDLE◀──DEPOSIT◀──到达 Core 格──┘                 │
        （离开 Core 后）                          （满仓则让位）
```

- 状态由（cargo、位置、资源格集合）**确定性推导**，不引入持久状态机
  变量（重启一致性）；跨 tick 持久仅限：巡逻目标/方向/停滞指纹/
  指挥模式。
- **停滞跳出是状态机的关键出口**：任何状态停留过久（位置指纹
  不变）都会触发换目标，避免"合法但无效"的循环。

## 5. 遥测

- decision 记录新增：`directiveMode`（当前指挥模式）
- 事件：`economy.stagnant`（30 tick 无进展）、`migration.candidate`
  （MIGRATE_CAND 触发）、`unit.stuck_yield`（停滞跳出次数）

## 7. 游戏逻辑利用（refill / 视野揭示）

官方规则（v0.13）落地为 sim 引擎（`internal/sim/refill.go` / `vision.go`）：
- 资源每 4 tick 每个 chunk 配额补满 `max(2, floor(128/(8+ring)))`；
- 只有视野扫过的格才 reveal（进入 ResourceCells）——并集视野
  Worker 3 / Core 5 / Vanguard 4 / Ranger 5；
- 采空格立即消失（harvest 后从 ResourceCells 移除，markMined）。

planner 侧四条语义（refill 场景真实化后暴露的振荡/死循环修复）：

| 规则 | 场景 | 修复 |
|---|---|---|
| 排队不绕行 | 拥挤时 BFS 绕行路径每 tick 变化 → 横跳振荡 | moveToward 不把己方单位并入 BFS 障碍；理想第一步被占 → WAIT 排队 |
| 目标被占走相邻 | 回仓 worker 目标 Core 格被占 | 走到目标相邻格等待（已在相邻则 WAIT） |
| 空载让出仓库口 | deposit 完的空载 worker 在 Core 上等分配，仲裁失败原地 WAIT | 仲裁降级 + 空载 + 在 Core 上 → 让位（yield_core_wait） |
| Core 格路径语义 | 探索 worker 反复穿过 Core 格堵住回仓 | 目标非 Core 时 Core 视为障碍（路径不穿越仓库口） |

### 参数优化升级（refill 评分）

optsearch 挂载 refill 引擎后重新搜索（双算法共识）：
- 旧模型（资源永不再生）：SA/GA 同分，参数区分度低；
- refill 模型：默认 129 分 → SA `{6,1,16,21}`=174（+35%）、
  GA `{10,1,22,13}`=174；**共识 spawnReserve=1**（资源持续流入，
  攒资源浪费大于 buffer 收益）；
- DefaultConfig 落地 SA 解：workerTarget 8→6、spawnReserve 5→1、
  populationCeiling 20→21。

## 8. 军事战术层（2026-08-05）

| 战术 | 触发 | 行为 |
|---|---|---|
| `SWEEP` | Vanguard 相邻格有敌方单位/Core | AOE 1 伤害（比逼近优先） |
| `SHOOT` | Ranger 3 格内敌人、视线无遮挡 | 1 伤害（target_id 精度） |
| `kite`（放风筝） | Ranger 敌人距离 ≤2（近战威胁） | 朝反方向撤退保持射程优势 |
| `engage` | Vanguard 威胁距离内敌人 | 逼近（moveToward） |
| `disengage`（追敌超时） | engage 连续 8 tick 未进入 SWEEP 射程 | 放弃追击回核心/巡逻 |
| 军事生产 | worker 达 WorkerTarget 且军事占比 < MilitaryRatio | Vanguard/Ranger 交替 spawn |

战斗结算（sim 侧，官方顺序）：MOVE → HARVEST/DEPOSIT → 己方攻击
（SHOOT/SWEEP，快照同时结算）→ 敌方攻击（Vanguard 相邻/Ranger 八方向
1-3，Shield 优先扣）→ 单位 HEAL → Core SPAWN/HEAL/REPAIR_SHIELD。

## 9. 红线

- MIGRATE_CAND **只评估不执行**：START_MOVE 需要 operator 显式启用
  （配置 `enableCoreMigration: true`）后才会由 planner 发出。
- 停滞跳出只改巡逻目标，**不产生非法动作**（目标更换后仍走
  StepToward + validator）。
- 指挥模式切换确定性：同输入序列同模式序列。
