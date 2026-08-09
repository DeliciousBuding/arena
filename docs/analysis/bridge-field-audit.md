# 桥状态字段并集审计（R2，2026-08-09）

日期：2026-08-09 · 来源：R2 线静态分析（5 个 Python agent 决策源码）
代码：`packages/arena-agent/src/sim/opponent/protocol-bridge.ts`（tickStateToProto 投影）
目的：桥状态投影（`bridgeProjection`）只序列化决策所需字段——先审计各 agent
实际读取的 PlayerState 字段并集，否则破坏逐字节一致性（评测验证基线）。

## 0. 方法

- 对象：`scripts/python-agents.json` 注册的 5 个 agent（farmer/core/waaiging/
  tactic/arena-evolve）的决策入口（`choose_actions`/`plan_turn`/`decide`）及
  其调用的 SDK `Turn`/`Unit`/`Core` 属性与策略模块。
- 注意：官方 SDK `Turn.__init__`（turn.py）对**每个** agent 无条件读取
  `state.objects`（含每对象 `kind`/`controlled`/`unit_type`/地形 `positions`）
  并预计算 `workers/vanguards/rangers/units/core/visible_enemies/terrain/
  obstacle_cells/resource_cells`——这些计入每个 agent 的读取集。
- 判定标准：投影后 agent 行为逐字节一致 = 同 seed 模拟结果逐字段一致
  （kills/ledger/事件序），验证见 `perf-optimization-2026-08-09.md` §5。

## 1. 各 agent 读取字段表

图例：✓ = 直接读取；— = 不读。`state.*` 指 PlayerState 顶层；Turn 属性
（`turn.resources`/`turn.beacon` 等）与 `state.*` 同一字段源。

### 1.1 farmer（arena-hero-agent，`CoreFarmer.choose_actions`）

| 字段 | 读取 | 说明 |
|---|---|---|
| state.objects | ✓ | 经 Turn 构建（kind/controlled/unit_type/positions 必读） |
| state.resources | ✓ | `turn.resources`/`turn.resource_space` |
| state.population | ✓ | `turn.resource_capacity`（经 rules.core_resource_capacity） |
| state.champion_beacon | ✓ | `turn.beacon.position`（距离计算）/`.status`（GROUND 判定） |
| state.events | ✓ | `event.event_type`/`reason_code`/`values`（amount/cost 经 getattr）/`event.healing`（→values） |
| state.status / respawn_at_tick | — | 不读 |
| CoreView | ✓ | `core.view.state`/`destination`/`move_progress`/`move_required_ticks`/`hp`/`shield`/`position`/`id` |
| CoreView.move_direction | — | 不读（仅 waaiging/evolve 读） |
| UnitView（己方） | ✓ | `position`/`id`/`unit_type`/`hp`/`cargo`（worker）/`view.state` |
| UnitView（敌方） | ✓ | `position`/`id`/`unit_type`/`hp`；敌方核心 `state` |
| TerrainView | ✓ | `obstacle_cells`/`resource_cells`（批量） |
| beacon.carrier_id | — | 不读 |
| owner_username | — | 不读（仅 evolve 读） |

### 1.2 core（arena-hero-guide，`plan_turn`）

| 字段 | 读取 | 说明 |
|---|---|---|
| state.objects | ✓ | 经 Turn 构建 |
| state.resources | ✓ | `turn.resources`/`resource_capacity` |
| state.population | ✓ | `turn.state.population`（MAX_AUTO_POPULATION 判定） |
| state.status | ✓ | `turn.state.status is not PlayerStatus.ACTIVE`（重生判定） |
| state.events | ✓ | `event.event_type`/`reason_code`/`actor_id`/`target_id`/`position`/`resource_amount`（→values） |
| state.champion_beacon | — | 整组不读（5 agent 中唯一不读 beacon 的） |
| CoreView | ✓ | `core.view.state`（NORMAL/MOVING）/`hp`/`position`/`id` |
| CoreView 迁移字段 | — | destination/move_progress/move_direction/move_required_ticks 全不读 |
| CoreView.shield / owner_username | — | 不读 |
| UnitView | ✓ | worker `cargo`/`id`；unit `hp`/`position`；敌方 `kind`/`position`/`id` |
| TerrainView | ✓ | `resource_cells`/`obstacle_cells` |
| respawn_at_tick | — | 不读（用 status 判定） |

### 1.3 waaiging（arena-hero-clone-waaiging，`SmartTactic.choose_actions`）

| 字段 | 读取 | 说明 |
|---|---|---|
| state.objects | ✓ | 经 Turn 构建 |
| state.resources | ✓ | 经济决策 |
| state.population | ✓ | `turn.resource_capacity` |
| state.champion_beacon | ✓ | `turn.beacon.status`（CARRIED/GROUND）/`carrier_id`（`in owned_ids`）/`position` |
| state.events | ✓ | `event.event_type`/`position`/`target_id`/`reason_code`/`tick`/`actor_id`/`resource_amount`/`harvest_source`（→values） |
| CoreView | ✓ | `core.view.state`/`move_direction`/`destination`/`shield`/`hp`/`position`/`id`；`turn.core.shield` |
| CoreView.move_progress / move_required_ticks | — | 不读 |
| UnitView | ✓ | worker `cargo`/`id`/`position`/`unit_type`/`hp`；敌方 `hp`/`shield`（CoreView 判型）/`state` |
| TerrainView | ✓ | `resource_cells`/`obstacle_cells` |
| state.status / respawn_at_tick / owner_username | — | 不读 |

### 1.4 tactic（arena-hero-tactic，`bot.strategy.decide` + bot/* 模块）

| 字段 | 读取 | 说明 |
|---|---|---|
| state.objects | ✓ | 经 Turn 构建 |
| state.resources | ✓ | `turn.resources`（economy 回退 `state.resources`） |
| state.population | — | 用 `count_by_type`（workers/vanguards/rangers 计数）而非 population 字段 |
| state.status | ✓ | `state.status` 为 RESPAWNING 时整 tick 空转 |
| state.respawn_at_tick | ✓ | 重生时读取（日志/等待） |
| state.champion_beacon | ✓ | `beacon.status`/`position`/`carrier_id`（CARRIED 清除记忆） |
| state.events | ✓ | memory.observe：`event.event_type`（CARGO_DROPPED 判定）/`position`/`values`（amount）——getattr 字面量访问 |
| CoreView | ✓ | `core.position`/`hp`（adjacent_enemy_low_hp 判定）；`core.resources` 经 getattr 回退（Core 控制器无此字段，恒 None，不构成 wire 读） |
| CoreView 迁移字段 / shield / owner_username | — | 不读 |
| UnitView | ✓ | worker/vanguard/ranger `position`/`id`/`unit_type`/`cargo`/`hp` |
| TerrainView | ✓ | `resource_cells`/`obstacle_cells` |
| event 的 reason_code/actor_id/target_id/tick | — | 不读 |

### 1.5 arena-evolve（arena-evolve，`ArenaEvolveAgent.choose_actions` → LiveAdapter.build_observation）

| 字段 | 读取 | 说明 |
|---|---|---|
| state.objects | ✓ | 经 Turn 构建 |
| state.resources | ✓ | `turn.resources` |
| state.population | ✓ | `state.population`（Observation） |
| state.status | ✓ | `state.status.value`（RESPAWNING 判定） |
| state.respawn_at_tick | ✓ | `getattr(state, "respawn_at_tick")` |
| state.champion_beacon | ✓ | `beacon.position`/`status`/`carrier_id`（carries_beacon 推导） |
| state.events | ✓ | translate_events：`event_type`/`actor_id`/`tick`/`reason_code`/`target_id`/`position`/`values`/`resource_amount` |
| CoreView（己方） | ✓ | `view.position`/`id`/`hp`/`shield`/`move_direction`/`move_progress`（migration 元组） |
| CoreView.move_required_ticks / destination | — | 不读 |
| CoreView（敌方） | ✓ | `id`/`position`/`hp`/`shield`/`owner_username`（5 agent 中唯一读 owner_username 的） |
| UnitView | ✓ | 己方 `view.position`/`id`/`unit_type`/`hp`/`cargo`；敌方 `id`/`unit_type`/`position`/`hp` |
| TerrainView | ✓ | `resource_cells`/`obstacle_cells` |

## 2. 字段并集（投影必保）

顶层：`status`、`respawn_at_tick`、`resources`、`population`、`champion_beacon
{position, status, carrier_id}`、`objects`、`events`

CoreView：`kind`、`id`、`controlled`、`owner_username`、`position`、`hp`、
`shield`、`state`、`move_direction`、`move_progress`、`move_required_ticks`、
`destination`（全字段均被 ≥1 agent 读取）

UnitView：`kind`、`id`、`controlled`、`position`、`hp`、`unit_type`、`cargo`

TerrainView：`kind`、`positions`

ResolutionEvent：`event_id`、`tick`、`event_type`、`reason_code`、`actor_id`、
`target_id`、`position`、`values`

> 结论：并集 = 现状 wire 全字段——**没有"任何 agent 都不读"的字段可整字段
> 删除**。投影的实际收益来自**值条件省略**（见 §4）：恒 null 的可选字段省略，
> 桥端 pydantic 默认 None 还原，值语义逐字节不变。事件数组无法为并集模式
> 删除（4/5 agent 读取；tactic 只读 event_type/position/values，为并集子集）。

## 3. 必保字段（引擎结算/协议必需，与 agent 读取无关）

| 字段 | 原因 |
|---|---|
| tick（信封 `{tick, state}`） | 决策器回带计划必须引用正确 tick；agent 记忆/日志用 |
| selfPlayerId（服务端参数） | 判定 controlled=true（"我方"标记） |
| kind（判别联合） | pydantic Union discriminator（extra="forbid" 严格模式） |
| event_id / tick / event_type | pydantic 必填字段（无默认值） |
| MOVING 核心全迁移字段 | `CoreView` validator：MOVING 要求 4 字段全非 None |
| RESPAWNING 时 respawn_at_tick | `PlayerState` validator：RESPAWNING 必须有值 |
| CARRIED 时 carrier_id | `ChampionBeacon` validator：CARRIED ↔ carrier_id 配对 |
| status / resources / population / objects / events | pydantic 必填（无默认值） |

## 4. 可省略字段（值条件省略，pydantic 默认 None 还原）

对**并集内**字段：当值为 null 时省略键——省略后桥端 pydantic 取默认 None，
agent 看到的值与显式 null **逐字节相同**。省略集（均为 pydantic 有默认值字段）：

| 省略条件 | 字段 | 验证 |
|---|---|---|
| status == ACTIVE 且为 null | `respawn_at_tick` | pydantic 默认 None；validator 仅 RESPAWNING 强制 |
| 核心 state == NORMAL | `move_direction`/`move_progress`/`move_required_ticks`/`destination` | 默认 None；validator 仅 MOVING 强制全带 |
| 单位非受控 WORKER（值恒 null） | `cargo` | 默认 None；validator 仅受控 WORKER 可有值 |
| beacon status/carrier_id 为 null | `status`/`carrier_id` | 默认 None；CARRIED 必有值（不省略） |
| event 可选字段为 null | `reason_code`/`actor_id`/`target_id`/`position`/`values` | 默认 None |

**pydantic 缺失字段行为验证**（reference SDK 0.2.6，`PlayerState.model_validate`
实测通过）：省略上述字段的最小化 state 校验通过，还原值全部 None；MOVING
核心缺字段 / RESPAWNING 缺 respawn_at_tick 均被 validator 拒绝（= 投影保留
逻辑的必要性）。另注：机器 site-packages 装有含 `population_tier`/
`upkeep_next_tick` 必填字段的异版 SDK——桥接经 sys.path 钉死 reference SDK
（0.2.6），不受影响。

## 5. 动态读字段检查（逐 agent 降级判定）

| agent | 反射/遍历 | 判定 |
|---|---|---|
| farmer | getattr 均为字面量名（cargo/kind/id/event_type/values...）；model_dump 仅作用于 turn.plan（输出） | 可投影 |
| core | 无 getattr 状态访问；events 直接属性访问 | 可投影 |
| waaiging | 无 getattr 状态访问 | 可投影 |
| tactic | getattr 均为字面量名（status/beacon/events/resource_cells...） | 可投影 |
| arena-evolve | build_observation 直接属性访问；`__getattr__` 包装仅用于离线 ahsim 模拟器（非 PlayerState 路径） | 可投影 |

结论：5/5 可静态枚举，**无 agent 需降级不投影**。实现上的逐 agent 开关 =
`BRIDGE_PROJECTION_AUDITED_AGENTS` 白名单（protocol-bridge.ts）——仅白名单
内 agent 启用投影；未审计的第三方/HTTP 端点（黑盒，字段读取不可控）不投影。
未来审计中发现动态读字段的 agent 从白名单移除即降级。

## 6. 与 SDK Turn 基类读取的重叠说明

`Turn.__init__` 对每个 agent 无条件读 `state.objects` 及 `kind`/`controlled`/
`unit_type`/地形 `positions`——即使某 agent 源码零读取，Turn 基类也已覆盖
这些字段，因此它们无条件入并集（投影永不省略）。

## 7. 参考实现

- 投影实现：`tickStateToProto(state, selfPlayerId, { projectFields })`
  （protocol-bridge.ts）+ `OpponentAdapter.setProjection` + `runFreeForAll
  { bridgeProjection }`（tournament.ts）。
- 一致性/收益验证：`docs/analysis/perf-optimization-2026-08-09.md` §5/§6。
