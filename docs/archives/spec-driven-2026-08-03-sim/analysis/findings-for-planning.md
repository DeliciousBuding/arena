# 发现文档：Arena 本地经济模拟器（Digital Twin MVP）

> 用途：给计划制定者（GPT）的输入。基于 2026-08-03 规划快照（HEAD 4f5151a）；
> 后续主干提交不回写本归档，当前状态请看 `docs/progress/MASTER.md`。
> 目标：**本地光速模拟**（1000× 加速），把策略验证从"15s/tick 线上窗口"变成"秒级/轮"。
> 硬约束：**模拟器不得污染真实操作**（6 条隔离边界，见 §3）。

---

## 0. 权威来源层级（出计划前必读）

> **强制要求：本仓库内所有规则/API 知识都是二手或镜像的，出计划前必须到官方仓库核对原文。**
> 本发现文档中的规则数值引自本仓库整理的 `docs/game-rules.md`（二手转述），**不得直接作为最终依据**。

### 官方源（权威，优先于本仓库任何文档）

| 源 | 位置 | 内容 |
|---|---|---|
| **arena-hero-doc 官方仓库** | `github.com/arena-hero/arena-hero-doc`（rules/api/reference 文档站源码） | 游戏规则、API、changelog 的**原始权威**。模拟器要复现的结算行为以此为准 |
| **arena-hero-python 官方仓库** | `github.com/arena-hero/arena-hero-python`（Apache-2.0） | 官方 Python SDK（协议编码、turn 语义） |
| 官方 changelog | arena-hero-doc 仓库 `docs/reference/changelog.md` | 规则版本变更历史（v0.11 是最新？出计划时**再核对一遍**） |

### 本仓库镜像（跟随官方同步，可作为对照但非权威）

| 镜像 | 位置 | 说明 |
|---|---|---|
| 官方 Python SDK 源码镜像 | `reference/arena-hero-python/` | 官方源码快照，`sync-log.md` 记录同步状态 |
| 官方文档站镜像 | `.agents/skills/arena-hero-doc/`（及 `docs/rules/` 同步副本） | Docusaurus 文档站镜像，含 world-and-ticks.md 等 |
| 官方 TS fork 历史 | 原 `DeliciousBuding/arena-hero-ts`（已并入本仓库 `packages/arena-hero-ts/`） | wire schema 已单源化 |

### 本仓库自研（非官方，计划中只能作为"我们的实现/推断"）

| 文档 | 说明 |
|---|---|
| `docs/game-rules.md` | **我们整理**的规则契约（2026-08-02 对过 changelog，但仍是二手转述） |
| `docs/roadmap-long-term.md` | **我们**的 W10 Digital Twin 规划（W10 章节） |
| `fixtures/differential/burnin-*` | **我们**录制的真实线上 tick 数据（fixture_user 是测试账号） |
| `mapstore/`、`src/arena_bot/map_store.py` | **我们**自研的地图测绘/共享存储 |
| `packages/arena-agent/`（domain/planning/strategies） | **我们**自研的决策编排层 |
| 本发现文档全部规则数值 | 二手转述，须回官方核对 |

### 出计划时的强制查证项（GPT 必须做）

1. 打开官方 `arena-hero-doc` 仓库，核对**当前最新规则版本**（changelog 是否有 v0.11 之后的新 release）——我们的 game-rules.md 检查日期是 2026-08-02
2. 结算顺序（resolution order）、经济数值、视野规则、移动容量：逐条对照官方原文，**发现差异以官方为准**并记录差异（回写本仓库 game-rules.md）
3. 官方 Python SDK 的 `turn.py`/`client.py`：确认动作编码/提交语义没有我们遗漏的细节
4. 若官方文档更新，本计划的规则版本假设必须跟随官方最新版

---

## 1. 背景与动机

- 线上 tick = 15s 全局命令窗口（game-rules.md:151）。一天 5760 tick。
- GPT 现在优化确定性 planner：每轮验证只能看 33~100 tick 短窗口（8~25 分钟），噪声大 → 盲调多、推进慢。
- 模拟器价值：策略验证从"25 分钟/轮"→"秒级/轮"；**相对比较**（同环境 A/B）不要求绝对保真即可用。
- 项目优先级链（MASTER.md）：正确性 → 可恢复性 → 可观测性 → 确定性算法收益 → 数据质量 → **模拟器** → ML/Bandit → RL。红线："不在模拟器校准前启动 RL 主线"。

## 2. 范围（本期 MVP）

**做**：movement / economy / vision 结算引擎 + 快照载入 + Golden 校准 + 策略接入 benchmark。
**不做**：combat（Vanguard/Ranger/SHOOT/SWEEP）、Core 迁移、对手模型、refill 精确复现。
**用途**：先服务 GPT 现在 80% 的需求（避让/容量/经济闭环正确性 + 相对收益比较）。

## 3. 硬约束：不污染真实操作（6 条隔离边界）

| # | 边界 | 实现方式 |
|---|---|---|
| 1 | 进程隔离 | sim 独立 CLI 进程（`run-sim.ts`），与 `tenant-runtime.ts` 零共享 |
| 2 | **提交通道隔离（最高优先）** | sim 目录**禁 import** `client.ts` / `arena-hero-ts` 的 client（脚本强制检查）；**不加载 .env**；submitter = 本地结算引擎。从代码结构上无网络提交能力 |
| 3 | 锁/端口隔离 | 不碰 `single-writer-lock.ts`；不占 8123-8126 调试端口 |
| 4 | 数据隔离 | 只读 `fixtures/` 与 mapstore（快照导入）；写入 `runs/sim-<id>/`（与线上 `runs/run-*` 命名分区） |
| 5 | CPU 隔离 | 默认串行/低并发，不抢 burn-in 进程（pid 39064 在跑） |
| 6 | 产物隔离 | sim JSONL 独立 schema 前缀，不混入线上 telemetry |

**隔离的强制手段**（防回归）：脚本检查 `src/sim/**` 不出现 `import ... client`；sim 入口不读 `.env`；CI/`npm run check` 纳入。

## 4. 架构建议：模拟器 = 一台"假的线上服务器"

```text
SimWorld（全知）
  → vision 裁剪 → PlayerState（与线上同构）
  → state-reducer.reduceTurn → TickState
  → 策略（DeterministicPlanner/SafetyPlanner，零改动）
  → Plan → 模拟结算引擎 (world, plans) → nextWorld
  → 循环；每 tick 记录决策/结算 JSONL
```

关键点：
- **策略层永远只看到 PlayerState/TickState**，与线上完全同构 → 线上代码 = 模拟代码，sim-to-real gap 最小
- 结算引擎是**纯函数**：`(world, plans) → nextWorld`，确定性、随机源显式注入 → 可并行/可复现
- 视野双模式：训练全知 / 评估遮蔽（遮蔽后模拟器生成的 PlayerState 与真实完全同构）

## 5. 现有代码地图（可复用件）

### 5.1 策略输入类型（零改动复用）

| 文件 | 内容 |
|---|---|
| `packages/arena-hero-ts/src/types.ts` | `PlayerState` / `UnitView` / `CoreView` / `TerrainView` / `ResolutionEvent`（原始线上协议） |
| `packages/arena-agent/src/domain/model.ts` | `TickState`（策略输入快照）/ `UnitAction` / `CoreAction` / `Plan` / `cellKey` |
| `packages/arena-agent/src/domain/state-reducer.ts` | `reduceTurn(turn: TurnLike) → TickState`——**模拟器生成 PlayerState 后直接复用**（TurnLike 是鸭子类型，构造即可） |

### 5.2 策略（零改动复用）

| 文件 | 接口 |
|---|---|
| `planning/deterministic-planner.ts` | `class DeterministicPlanner implements PlanProvider`：`decide({state: TickState}) → Plan`（含 `resolveMoveCapacity` 客户端容量预裁决、`stepTowardAvoiding` 障碍避让、跨 Tick 世界记忆在 SafetyPlanner 内） |
| `strategies/safety-planner.ts` | `class SafetyPlanner`（默认配置 DEFAULT_SAFETY_CONFIG；内含跨 Tick World：障碍/资源线索/巡逻状态） |
| `runtime/decision-types.ts` | `PlanProvider` 接口定义 |

注意：Planner 有**跨 Tick 内部状态**（previousAssignments、SafetyPlanner.world），模拟器驱动时每个模拟"租户"要实例化独立 planner，不能共享。

### 5.3 数据与规则源

| 文件 | 内容 |
|---|---|
| `docs/game-rules.md`（778 行，v0.11） | **二手整理的规则契约**（检查日期 2026-08-02）——出计划时对照官方 arena-hero-doc 仓库核验后再用（见 §0） |
| `fixtures/differential/burnin-20260802-a/*.json` | 数百个**真实连续 tick** 原始 PlayerState（40437+ 起），Golden 校准素材 |
| `scripts/differential/fixture_builder.py` | fixture 构建工具（Python 侧） |
| `mapstore/arena_map.db` | 共享地图测绘库（SQLite WAL）——模拟器只读导入已知障碍 |

### 5.4 fixture JSON 格式（burnin 样本）

```json
{"status":"ACTIVE","respawn_at_tick":null,"resources":1,"population":3,
 "champion_beacon":{"position":[-17,77],"status":null,"carrier_id":null},
 "objects":[{"kind":"OBSTACLE","positions":[[17,-86],...]},
            {"kind":"CORE","id":"...","controlled":true,"owner_username":"fixture_user",
             "position":[20,-97],"hp":5,"shield":5,"state":"NORMAL",...},
            {"kind":"UNIT","id":"...","controlled":true,"position":[20,-86],"hp":2,
             "unit_type":"WORKER","cargo":1}],
 "events":[{"event_id":"...","tick":40436,"event_type":"UNIT_MOVE_SUCCEEDED",
            "reason_code":null,"actor_id":"...","position":[20,-86],"values":null}]}
```

## 6. 规则数值表（MVP 结算引擎必须实现，全部引自 game-rules.md）

> ⚠️ **均为二手转述**。出处列的是本仓库 game-rules.md 行号；**出计划前逐条对照官方 arena-hero-doc 仓库核对**，
> 官方原文与本表不一致时以官方为准，并把差异回写到本仓库 game-rules.md（含同步日期）。

### 6.1 经济（§264-430）

| 规则 | 数值 | 出处 |
|---|---|---|
| 资源容量 | `max(10, population × 5)`；population 只数活单位 | §284 |
| 生产价格 | Worker 5 / Vanguard 10 / Ranger 12 | §314 |
| 每 tick spawn 上限 | 1；新单位出生在 Core 格；格容量 2（Core 已占 1 槽）；满格失败 `CELL_UNIT_LIMIT` 不扣费；出生 Tick 不能行动、不付 upkeep | §318-325 |
| 出生/重生初始 | 1 Worker + 5 资源 | §291 |
| upkeep | `tier = floor(N/20)`；`upkeep = tier×(tier+1)/2`；0-19 人口 = 0 | §402 |
| upkeep 不足 | 资源归零；缺口每 1 资源 → 1 HP 伤害给"多余单位"：离 Core 最近的 19 个受保护，其余从远到近（Manhattan 距离，平手按 UUID）受伤害 | §419-425 |
| HARVEST | 空 Worker 在 RESOURCE 格 +1（持 Beacon +2）；成功消耗整节点；多 Worker 抢同一节点仅**最低 UUID（raw byte）**成功，其余 `HARVEST_FAILED/RESOURCE_DEPLETED`；有 cargo 者 `CARGO_FULL` | §466-480 |
| DEPOSIT | 与自己的非迁移 Core 同格；只存得下部分；满 Core `DEPOSIT_FAILED/CORE_RESOURCE_FULL` 保留 cargo；成功报 `{amount, capacity, remaining}` | §482-488 |
| Worker 死亡 | cargo 全量掉落成格上持久资源堆（先于自然节点被回收） | §489, §105 |
| HEAL | 1 HP/1 资源；需与静止 Core 同格；战后结算；单位 heal 按 raw UUID 升序先于 Core action | §331-340 |
| REPAIR_SHIELD | 恰 1 资源 → 恰 1 护盾 | §355 |
| 资源节点 | 每 chunk 配额；成功 harvest 立即移除节点；refill 每 4 tick 一次（seed 保密，**不可预测** → MVP 标记 unknown） | §100-103, §194 |

### 6.2 移动（§528-579）

| 规则 | 数值 |
|---|---|
| 移动 | 每单位每 tick 最多 1 个直边格，消耗该单位 action |
| 格容量 | 每格 ≤2 实体（Core/Worker/Vanguard/Ranger 各算 1） |
| 跨玩家 | 不同玩家对象**禁止**同格结束 tick |
| 碰撞 | 同玩家争不足槽位：**最低 UUID（raw byte）**获得，其余 `CELL_UNIT_LIMIT` |
| 依赖链 | 可进入将要离开的格（A→B 格、B→C 格、C→空）；任一处失败则回溯传播失败；跨玩家不可交换位置；≥4 格环可能成功 |
| 历史超容量格 | 不可接收移动/spawn，只能减少 |

### 6.3 视野（§219-239，MVP 遮蔽模式需要）

| 对象 | 半径（Manhattan） |
|---|---|
| Core | 5 |
| Worker | 3 |
| Vanguard | 4 |
| Ranger | 5 |

- 当前视图 = 所有活体友好对象视野的并集
- 障碍用整数 supercover 线遮挡（障碍格本身可见，其后不可见；过角两边都算）
- state 内容规则：己方单位/资源点/Core 永远全量（含视野外）；敌方仅在可见时；Beacon 坐标对所有人恒可见

### 6.4 结算顺序（§169-198，MVP 裁剪）

完整 16 步。**MVP 实现**：1（锁定 plan）→ 2（SELF_DESTRUCT）→ 3（容量收缩销毁超量资源）→ 4（upkeep 结算 + 缺额伤害）→ 5（单位移动，依赖图）→ 8（harvest/deposit）→ 12（Core action 的 SPAWN/HEAL/REPAIR_SHIELD 子集）→ 15（提交）。
**MVP 跳过**：6/7（Core 迁移/Beacon）、9-11（combat）、13（respawn）、14（refill——标记 unknown）。

## 7. 验证方法：Golden Simulation（校准循环）

1. 从 fixture 序列取 tick N 的真实 `PlayerState` → 构造 `SimWorld`（己方全知 + 已见地形；视野外/对手标记 unknown）
2. 把 tick N 的**真实提交 plan** 喂模拟器结算 → 得 tick N+1 的预测 `PlayerState`
3. 与 fixture 中 tick N+1 的真实 state 对比，输出差异分类：
   - `visible-terrain` / `resource-refill` / `opponent-action` / `rule-misunderstood` / `engine-bug`
4. 目标：**可解释差异率 100%**（engine-bug 与 rule-misunderstood 必须为 0 或逐条解释）；确定性事件一致率尽量高

差分素材：`fixtures/differential/burnin-20260802-a/40437.json` 起连续 ~250 tick。
现有 `scripts/diff_replay.py` / `fixture_builder.py` 是 Python 侧差分基建，可参考或另建 TS 侧。

## 8. 已知边界（不可消除，模拟器设计要接受）

| 边界 | 原因 | 处理 |
|---|---|---|
| refill 不可预测 | 永久 secret world seed（game-rules.md:63），客户端永远拿不到 | 显式随机源注入；差异分类标记 |
| 对手动作不可知 | 真实对手/其他玩家 | MVP 无对手；后续 ScriptedOpponent/ReplayOpponent |
| 视野外状态未知 | 部分可观测性 | 模拟器内未知区域标记，不做全知补齐 |
| 规则数值漂移 | 服务端可升级（v0.11 是 2026-08-02 对过 changelog） | 规则常量集中一个文件 + 版本注释；升级时同步 |

## 9. 建议里程碑（供计划参考，非定论）

| M | 内容 | 完成标准 |
|---|---|---|
| M1 引擎核心 | world.ts + settlement 循环 + movement/economy 结算 + 快照载入 | 单测绿；能载入真实快照跑 N tick 不崩溃 |
| M2 Golden 校准 | burnin 重放对比 + 差异分类报告 | 可解释差异率 100%；engine-bug=0 |
| M3 可用闭环 | sim CLI + 隔离强制 + 策略接入 benchmark | `npm run arena:sim -- --strategy deterministic --ticks 10000` 一条命令出指标（合法动作率/repair/经济曲线/tick 吞吐） |
| M4 固化 | 单测全套 + docs/simulator.md 覆盖矩阵 + AGENTS.md 指引 GPT 先跑 sim | 全量门禁绿 |

## 10. 关键工程细节提醒

1. **TurnLike 鸭子类型**（state-reducer.ts:48）：模拟器构造 TurnLike 即可复用 `reduceTurn`，不必改 state-reducer
2. **Planner 跨 Tick 状态**：每个模拟租户独立实例化 planner（previousAssignments / SafetyPlanner.world）
3. **UUID 排序语义**："ascending raw UUID byte order" = 按字符串字节序（localeCompare 已用，与 TS 侧一致；与 Python 侧 compare_bytes 需对齐——差分时注意）
4. **测试命令**：`npx tsx --test "test/*.test.ts"`（node --test 只能跑 12/21，勿用）；全量门禁见 MASTER.md
5. **放置位置**：`packages/arena-agent/src/sim/`（与策略层同包复用类型）；CLI 在 `src/cli/run-sim.ts` + package.json 加 `arena:sim` script
6. **只读规则**：模拟器读 mapstore 必须开只读连接（`mode=ro`），禁止写

## 11. 参考文件

**官方（出计划时主动去查，不要只依赖本仓库副本）**
- `github.com/arena-hero/arena-hero-doc` — 规则/API/changelog 原始权威
- `github.com/arena-hero/arena-hero-python` — 官方 SDK（本仓库镜像：`reference/arena-hero-python/`）

**本仓库**
- `docs/game-rules.md`（二手整理，对照官方后用）
- `packages/arena-agent/src/domain/model.ts`、`state-reducer.ts`
- `packages/arena-agent/src/planning/deterministic-planner.ts`、`strategies/safety-planner.ts`
- `packages/arena-hero-ts/src/types.ts`、`turn.ts`
- `fixtures/differential/burnin-20260802-a/`
- `docs/progress/MASTER.md`（门禁/红线）
- `docs/roadmap-long-term.md`（W10 Digital Twin 原始规划）
