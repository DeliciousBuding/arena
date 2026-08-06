# Arena Hero 策略追赶方案 v2 — Pure Rust RTS Engine

> 来源：第一名算法说明、第二名公开仓库、TS 生产实证与 Rust 模拟器差距盘点。
> 落点：Pure Rust `domain + world + strategy + runtime + simulator`。策略只实现一次，生产、回放与模拟共享同一 Rust 逻辑。

## 1. 核心判断

- 不复制第一名代码，吸收全局匹配、资源记忆、目标迟滞、时空预约、威胁记忆和 Core 生存思想；
- 不复制第二名代码，吸收确定性、资源优先、离线优化、长时运行和严格工程边界；
- AI 不进入 Tick 热路径；
- 经济闭环和真实 settlement 证据优先于复杂战斗；
- Pure Rust 直接连接 Hero，不经 Go Host、FFI 或动态库。

目标形态：

```text
第一名策略深度
+ 第二名工程纪律
+ TS 真实数据/Runtime-Golden
+ Rust 原生生产运行时与模拟器
```

## 2. 当前 Rust 能力与差距

| 能力 | 当前 Rust strategy | 下一步 |
|---|---|---|
| 全局 Worker 分配 | 已有 `assign_workers`、claimed/harvesters 排序 | 从贪心升级为稳定最小成本匹配，保留目标粘性 |
| Worker 生命周期 | harvest/deposit/return/yield 已有 | 接真实 settlement telemetry 验证完整闭环 |
| 移动容量 | 事后仲裁与 WAIT 排队 | 事前 reservation、Core 入口预约、loser 改道 |
| 资源记忆 | 缺 | R3 首要：耗尽、失败路线、TTL、冷却 |
| 探索 | 确定性螺旋扫描 | chunk/frontier age、稳定扇区、blacklist、旧区域复查 |
| 导航 | bounded BFS/stuck 指纹 | 目标迟滞、A-B-A 消环、敌占格风险、长墙/窄口 |
| 威胁记忆 | 缺，仅即时敌人与 engage timeout | enemy belief、stationary/active、ETA/threat score |
| Core 防御 | 缺系统化布防 | 多轴防御、Ranger 外围、Vanguard 屏障、恢复与逃生 |
| 战斗 | 有基础攻击/追击 | 预测攻击格、包抄、堵路、撤退、有限 raid |
| 重启持久化 | planner 内存态 | 先保证单进程长时；真实需求出现后做原子快照 |
| 生产 runtime | 尚未 Rust-native | R1/R2：Hero client、exactly-once、lock、submit、telemetry |

## 3. 已有模拟基线

旧 Rust 策略 500 Tick golden：

| 场景 | deposits | spawns | workers（终） | resources（终） |
|---|---:|---:|---:|---:|
| base | 68 | 13 | 13 | 1 |
| dense | 154 | 16 | 13 | 0 |
| sparse | 30 | 7 | 9 | 0 |

这些数字只作为回归观察点，不直接代表真实服务器收益。正式比较必须绑定规则、refill、seed、profile 与 scenario hash。

## 4. 真实 t3/t4 数据画像

旧 decision.jsonl 样本显示：

- 真实资源极稀缺，deposit 很少；
- explore 意图占比约 92%–99.7%，空跑是最大损失；
- 人口通常只有 1–4 Worker，资源瓶颈压制扩张；
- capacity wait 在真实环境可见；
- 历史计划虽 validator 合法，但“accepted/valid”不能证明动作已经结算；
- 会话可能短且流会停顿，记忆必须会话内快速产生收益。

由此得到固定优先级：

```text
settlement 可观测
→ resource memory
→ exploration blacklist
→ move reservation
→ threat/Core defense
→ combat optimizer
```

## 5. 策略版本路线

### v0.1 — Worker Economy / Resource Memory

- 资源最后确认时间、采空、失败原因和冷却；
- 一资源一 Worker，全局成本包含去程、回 Core、风险、拥堵和 sticky bonus；
- 满仓满载 Worker 安全让位，不堵住 Core spawn；
- dropped cargo 回收；
- `planned_spawn_no_effect`、cargo stall 和资源 delta 遥测。

验收：economy-sparse、resource-far、core-gate 的净经济和尾部表现提升，0 invalid/repair。

### v0.2 — Map Memory / Exploration

- chunk/frontier age；
- 稳定方向扇区与连续外扩；
- blacklist 与封闭区域剪枝；
- 旧区域低频复查；
- 目标迟滞，避免频繁跨图切换。

验收：首次发现远资源更快、重复覆盖率下降、空探索 Tick 减少。

### v0.3 — Navigation / Reservation

- 障碍感知 A* 或 bounded BFS；
- 时空预约，格容量 2；
- Core 入口流量和 spawn/deposit 预约；
- swap/依赖链处理；
- route reuse、A-B-A 消环和失败路线冷却。

验收：obstacle-maze/core-gate 中无振荡、无永久 WAIT、决策延迟无长尾。

### v0.4 — Threat Model / Core Survival

- 敌人 last position、reachable set、当前视野排除；
- stationary/active 分类；
- 追逃关系和 ETA；
- Worker 风险路径；
- Core 重点防御区、双 Ranger 视野环、多轴突围和恢复。

验收：crossfire/enemy-aggressive 的 Core HP AUC 和最差 10% 不低于 TS 基线。

### v0.5 — Combat Optimizer

- 移动敌人有限候选攻击格；
- Ranger/Vanguard 自适应配比；
- 包抄、堵路、追击和撤退；
- Miss 后单单位贴近修正，其余保持拦截；
- confirmed stationary threat/Core 的有界 raid；
- 防御单位不被远方目标拉走。

验收：enemy-defensive/enemy-aggressive 场景跨至少 20 paired seeds 有正收益，尾部不恶化。

### v0.6 — Offline Optimizer / Production Calibration

- StrategyProfile 统一输入；
- simsearch/optsearch/paramscan/simgolden；
- TS Runtime-Golden 与 Rust replay；
- 真实意图分布、资源密度、结算失败率校准；
- 多目标评分：Core、净经济、探索、战斗、稳定性。

优化器只推荐 candidate profile，生产晋级仍走 shadow/bounded-live/canary 门禁。

## 6. 每 Tick 决策链

```text
receive normalized TickState
→ update World memory
→ classify strategic mode and immediate threats
→ generate forced tasks
→ global assignment
→ pathfinding + reservations
→ combat allocation
→ validate fail-closed
→ submit once
→ observe next-state settlement outcome
```

优先级：

```text
manual override（未来）
> Core 即时生存
> 当前防御/撤退
> 单位生存
> 满载回仓与经济破锁
> 已有持久任务
> 资源采集
> 跟踪/情报复查
> 探索
> 安全巡逻
> WAIT
```

## 7. 工程纪律

- 每个策略版本独立原子提交；
- 同时附 scenario、seed、tick、baseline、均值、中位数、p10、失败率和 hard gates；
- 不通过修改 golden、放宽 validator 或挑最好 seed 宣布提升；
- 正式运行必须记录实际 Rust git SHA 与 profile/rules/fixture hash；
- Rust planner invalid/repair 立即终止 run；
- 不维护 Go planner parity 作为长期目标；
- 不新增 FFI、Go fallback 或第二套 canonical domain；
- 生产先验证 settlement 和经济，再扩战斗。
