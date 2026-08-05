# Arena TS 主线执行计划

> 最后更新：2026-08-05。
> 状态：**当前 TS 主线执行 SSOT**。`roadmap-long-term.md` 保留长期愿景，本文件决定现在做什么、按什么顺序做、如何并行和何时停止。
> 适用范围：`packages/arena-hero-ts`、`packages/arena-agent`、TS 模拟器、TS 运行与评估工具。**不包含 Go 线。**

## 1. 总裁决

Arena TS 线不缺架构，也不缺代码提交；当前缺的是**稳定的能力开发节奏和可自动判定的收益闭环**。

接下来不再按“发现一个生产现象 → 修一个点 → 打一个版本 → 手工观察 → 补一轮状态文档”的方式无限串行推进。TS 主线改为三条有明确配额的轨道：

1. **可靠性与生产守门（20%）**：只处理 P0/P1、回滚、长期运行和专项证据；不主动扩展运维系统。
2. **确定性 Planner 与实际收益（50%）**：主开发轨道，目标是更快攒 Core、更低损耗、更少空转。
3. **评估、数据与模拟（30%）**：把“看日志判断”变成一键报告、可复现实验和自动晋级门禁。

任何一周若可靠性轨道没有 P0/P1，释放的时间全部进入 Planner 与评估，不再用来继续打磨服务器。

## 2. 北极星目标

### 2.1 未来 8 周

交付一个能够持续迭代的 **TS Deterministic Planner v2**：

- `main` 始终可发布、可回滚；
- 每次策略变更都有实验 ID、基线、主要指标、守门指标和结论；
- 同一状态可运行多个 Planner 候选并输出评分拆解；
- 模拟器可批量锦标赛，真实运行可做有界 champion/challenger；
- 业务指标以 `net_core_gain_per_100_ticks` 和 `ticks_to_redemption_target` 为主，不再以测试数量或提交数量代表进度；
- 确定性新冠军相对冻结基线，在足够窗口内实现 **≥10% 净收益提升**，且 P0 指标保持 0。

### 2.2 2026 Q4

在 TS 线上形成受控策略优化闭环：

```text
真实运行数据
→ 可校准模拟器
→ Planner 候选生成
→ 自动锦标赛与报告
→ Shadow / 有界 A-B
→ 人工晋级
```

低频 MacroPolicy 只负责有限战略参数，确定性 Planner 继续拥有逐 Tick 动作生成权。Bandit 或价值模型只有在数据和模拟器门禁满足后才进入实验，不得反过来阻塞当前确定性优化。

## 3. 当前基线与速度诊断

### 3.1 已具备的基础

当前 TS 线已经具备：

- TS SDK、协议/schema、单写者、deadline/lease/coordinator/validator、Supervisor；
- Docker + systemd 生产形态、健康检查、故障注入、回滚工具；
- DeterministicPlanner、Safety fallback、低频 MacroPolicy；
- Digital Twin、Runtime-Golden recorder/coverage、A-B 基础工具；
- TypeScript 7 原生编译器、Node 24 原生测试链；
- 针对回仓通道、资源满闭环、敌格阻塞、远距离 BFS、横跳和 stall 误报的一组生产回归。

因此下一阶段**不是继续搭地基**，而是使用这些地基提升收益。

### 3.2 2026-08-04 至 2026-08-05 本地审计

- 总提交：96；
- `docs`：29；`feat`：22；`fix`：22；
- 纯文档提交：26；
- 近期主循环是 v0.2.3–v0.2.15 的生产诊断、修复、发版和证据同步；
- 关键文件已出现明显集中：`tenant-runtime.ts` 710 行、`safety-planner.ts` 528 行、`deterministic-planner.ts` 518 行，但现在不做无收益的大拆分。

结论：原始产出速度很高，**有效能力吞吐低**，主要由以下因素造成：

1. 生产诊断、实现、部署、验证和文档更新由同一串行队列承担；
2. 每个小修复都独立发版和同步状态，批处理不足；
3. 缺少冻结 baseline 与统一 KPI，优化常从局部现象出发；
4. 实验配置、运行窗口、结果分析仍偏手工；
5. 长期路线 W7–W18 已被实现进度超越，但没有当前 1–6 周的可执行任务图；
6. 主 Planner 改动经常直接进入生产诊断，缺少“离线候选 → 自动报告 → 再上真机”的快速通道。

## 4. 不变边界

以下边界不因追求速度而放宽：

- 正式运行链始终为 `arena-hero-ts → arena-agent → SDK submit`；
- Pi/MacroPolicy 不持有 submit 权，不做 per-tick LLM 主线；
- 同租户只有一个 writer，live writer 不自动重启；
- wrong tick、duplicate submit、stale candidate、illegal final plan、orphan process 必须为 0；
- Python 实时 runtime 不恢复；
- 不建立第二套进程框架、控制面或配置系统；
- 不把 `INCONCLUSIVE` 写成 `MATCH`，不把 micro-Golden 写成 Runtime-Golden；
- 不在缺少数据和模拟器门禁时提前做 RL；
- 不为“代码整洁”大改稳定核心，拆分必须服务于一个正在交付的能力。

## 5. 新的开发操作系统

### 5.1 WIP 上限

同时最多三项活跃工作：

| 轨道 | 活跃上限 | 默认占比 | 允许内容 |
|---|---:|---:|---|
| A：可靠性 | 1 | 20% | P0/P1、rollback、golden、soak 结论 |
| B：Planner | 1 | 50% | 收益算法、候选、评分、动作质量 |
| C：评估 | 1 | 30% | KPI、实验、模拟器、报告、校准 |

不得同时开启两个相互重叠的 Planner 重构；不得用多个文档任务占满 WIP。

### 5.2 分支与合并

- 每项任务使用独立 worktree 和短分支；
- 一个分支只解决一个问题，目标在 1 个工作日内形成可审查提交；
- 超过 2 个工作日仍无法合并，必须拆成更小的行为保持切片；
- `main` 永远保持可发布；
- 同类小修复进入每日 release train，除 P0 外不再一修一发；
- `docs/generated/status.md` 只由生成器更新；普通进度文档按波次收口，不随每个小提交重复同步；
- 合并顺序固定为：契约/评估基础 → Planner 能力 → 实验配置 → 文档结论。

### 5.3 测试分层

| 层级 | 触发 | 目标 |
|---|---|---|
| T0 定向 | 编码循环 | 受影响测试和最小复现，快速反馈 |
| T1 包级 | 分支提交前 | `check` + 受影响 package tests |
| T2 全门禁 | PR/合并 | 全测试、schema、replay、status、docs health |
| T3 批量评估 | nightly/实验 | 多 seed 模拟器、候选锦标赛、回归场景 |
| T4 真实晋级 | 明确授权后 | shadow / bounded A-B / rollback evidence |

本地开发不必每个微小编辑都跑 T2；T2 由提交前和 CI 统一承担。任何行为变更必须至少有一个 T0 复现和一个 T3 场景。

### 5.4 每项能力任务的固定模板

每个任务必须包含：

```text
hypothesis
primary_metric
guardrails
baseline
implementation_scope
replay_or_sim_cases
promotion_rule
rollback_rule
```

没有主要指标的“优化”不进入 Planner 主线。

## 6. 未来 72 小时：速度重启波次

这一波只做让后续开发变快的最小闭环，不做新的大架构。

### TS-001：统一 KPI 报告

**目标**：一条命令读取现有 `runtime.jsonl`、`decision.jsonl`、`outcome.jsonl`、`policy.jsonl`，按租户和窗口输出：

- accepted/rejected/repair/deadline；
- 现有遥测可精确支持的 gross deposit、Core delta、spawn、heal、unit loss；
- worker/cargo/distance、intent 分布、capacity wait 和 stall；
- MacroPolicy 调用次数、延迟、失败和字段消费；
- `ticks_to_20/30/50` 的实际值，只有窗口满足稳定外推条件时才给预测；
- 对 upkeep、travel waste、军事清场 ROI、模型成本等暂不能精确推导的指标显式输出 `telemetry_gap`，不得猜值。

**落点**：扩展现有 `packages/arena-agent/src/analysis/burn-in-report.ts`，补一个统一 CLI；不另造第二套 report 模型，不引入数据库。

**完成定义**：同一份 fixture 重复运行结果确定；空/截断 JSONL fail-closed；输出 JSON + 人类可读摘要；保留现有 burn-in gates 并有新增测试。

### TS-002：冻结基线

冻结 `deterministic-v0.2.15`：

- git SHA、rules version、config hash、MacroPolicy 模式；
- 一组生产死锁回归场景；
- 一组标准模拟器 seeds；
- 当前 KPI 报告。

后续所有收益声明必须相对该基线，不再相对聊天记忆或不同版本窗口。

### TS-003：TS 实验清单 v1

现有根目录 YAML 是已退役 Python 实验的只读归档，不能复用为新执行入口。新建 `experiments/ts/`，在现有 `src/sim/tools/experiments.ts` 和 TS config 之上增加最小 manifest：

```text
experimentId
hypothesis
baselineVariant
candidateVariant
rulesVersion
seeds / ticks / tenants
primaryMetric
guardrails
configHash
gitSha
```

只做文件契约和读取校验，不做新配置中心。

### TS-004：命名 Planner variant 描述符

现有 `PlanProvider` 已是 SafetyPlanner / DeterministicPlanner 的冻结公共端口，不新增第二套 decide 契约，也不修改该接口。只增加最小描述符：

```ts
interface PlannerVariant {
  readonly id: string;
  readonly provider: PlanProvider;
}
```

现有 DeterministicPlanner 被包装为第一个 variant；模拟器继续通过已有 `EpisodeConfig.plannerFactory` 注入，生产继续直接使用 `PlanProvider`，默认行为零变化。描述符只服务于实验、A-B 和 champion/challenger。

### TS-005：减少状态同步噪声

- 生成状态漂移由 CI 提示或生成，不再手工追测试数字；
- `MASTER.md` 只记录已验证生产事实和阶段结论；
- 细粒度实验结果落在 artifacts/report，不堆进 MASTER；
- 每个波次只做一次文档收口提交。

### 72 小时退出条件

- 能一条命令生成 baseline KPI；
- 能以统一 manifest 跑一个 baseline 实验；
- 现有 DeterministicPlanner 通过 variant adapter 行为零变化；
- 全门禁通过；
- 不进行新的生产 live 变更。

## 7. 六周执行路线

## Wave 1（2026-08-08 至 2026-08-14）：Planner 竞赛骨架

### 目标

把“直接改唯一 Planner”变成“生成多个合法候选，离线比较后再晋级”。

### 交付

1. `PlannerVariantRegistry`：显式注册，不做插件系统，复用现有 `PlanProvider` / `plannerFactory`；
2. `CandidateEvaluator`：输出分数和 breakdown；
3. 扩展现有 `sim/tools/experiments.ts::runAB` 和 `ABReport`，使其接受命名 variant、输出中位数/P10/P90 和 guardrail；CLI 只是现有 A-B 能力的入口，不另造 tournament engine；
4. baseline variant + 至少两个候选：
   - `economy-v1`：缩短采集—回仓—存款周期；
   - `clear-path-v1`：把有限军事投入与回仓通道清理关联；
5. 报告包含中位数、P10/P90、最差 seed 和 guardrail 失败，而不是只看均值。

### CandidateEvaluator v1 指标

```text
+ deposit_value
+ redemption_progress
+ surviving_capacity_value
- spawn_investment
- upkeep_cost
- unit_loss_cost
- overflow_loss
- worker_idle_cost
- travel_waste
- cargo_blocked_cost
- core_risk
```

评分只用于比较合法候选，Validator 仍是最终安全边界。

### 晋级门槛

- 所有候选动作合法性 100%；
- baseline 结果可重复；
- 候选在标准 seeds 上主要指标正向；
- 任何 P0 guardrail 失败直接淘汰；
- 暂不进入生产。

## Wave 2（2026-08-15 至 2026-08-21）：Deterministic Planner v2

### 目标

解决“局部正确但长期收益差”的问题，不再只修单 Tick 症状。

### 工作包

#### TS-P2-1 全局 Worker 分配成本

从资源唯一分配升级到带成本的确定性分配：

- 距离和预计回仓时间；
- cargo 状态；
- 资源节点剩余量与过期记忆；
- Core 通道拥堵；
- 敌方占格和风险；
- 目标切换惩罚，减少反复改派。

第一版可用确定性排序/贪心，不立即引入复杂最优化依赖。

#### TS-P2-2 经济阶段控制

显式计算而非散落判断：

- 扩人口的回本期；
- accumulate target 所需容量；
- spawn reserve；
- upkeep 后的真实净收益；
- 达标后的停止消费；
- 资源耗尽/世界重置后的策略切换。

#### TS-P2-3 清场 ROI

军事单位不是固定比例消费，而是由以下证据触发：

- 满载 Worker 被阻塞的 tick 数；
- 回仓路径上的敌方密度；
- 因阻塞损失的预计 deposit；
- 当前军事单位的 upkeep 与生成成本；
- Core 风险。

MacroPolicy 的 `militaryRatio` 是上限/倾向，执行层仍进行经济门禁。

#### TS-P2-4 Planner 内部按行为边界拆分

只在交付上述能力时拆：

```text
planning/core-action.ts
planning/worker-assignment.ts
planning/combat-policy.ts
planning/path-policy.ts
planning/economy-model.ts
```

禁止一次性重写 500 行 Planner；每次抽取必须行为保持并有 golden/回归测试。

### Wave 2 晋级门槛

- 标准模拟器窗口相对冻结基线 `net_core_gain_per_100_ticks` 中位数提升 ≥10%；
- P10 不出现灾难性回退；
- `worker_idle_ratio`、`travel_waste_ratio`、`cargo_blocked_ticks` 至少两项改善；
- core destruction、illegal plan、submit 相关 P0 不退化；
- 通过专项生产复现场景。

## Wave 3（2026-08-22 至 2026-08-28）：真实度与专项证据

### 目标

关闭“模拟器看起来赢，但真实规则/部分可观测不支持”的风险。

### 交付

1. 专项 Runtime-Golden 数据集：
   - combat；
   - Core migration / 第四 Tick 争抢；
   - Beacon pickup/drop/death；
   - Core destruction/respawn；
2. 使用已有 coverage 工具生成机器可读报告；
3. calibration gap 按类别统计：known deterministic / opponent action / visibility / refill / server-private / simulator bug；
4. 把生产死锁与战场阻塞样本转成固定 scenario corpus；
5. 规则版本变化时自动使相关实验结论失效。

### 晋级门槛

- 已知确定性事件一致率 ≥99.9%；
- hard mismatch=0；
- unclassified=0；
- 私有服务端行为继续标记 unknown/inconclusive；
- 不用扩大模拟器范围掩盖缺证据。

## Wave 4（2026-08-29 至 2026-09-11）：自动实验与 Champion/Challenger

### 目标

把一次策略实验从“多轮手工操作”压缩为：

```text
manifest → sim tournament → report → approval → bounded real window → promotion/rollback
```

### 交付

- experiment runner 自动记录 gitSha/configHash/rulesVersion；
- 结果 artifact 包含原始 JSONL、摘要、失败 seeds 和结论；
- champion/challenger 配置明确，默认生产仍是 champion；
- 一次只允许一个 challenger 进入真实窗口；
- guardrail 自动判定 STOP / HOLD / PROMOTE；
- 发布按日批次，P0 例外。

### 真机晋级原则

真实 live 窗口必须另行明确授权。获得授权后：

1. shadow 合法性与时延；
2. 单租户 bounded window；
3. 交替窗口，避免只比较不同世界阶段；
4. 至少三组窗口、总计 ≥3,000 Tick；
5. 净收益提升 ≥10%，风险不升；
6. 否则回到模拟器，不在生产上继续试错。

## Wave 5（2026-09-12 至 2026-09-30）：MacroPolicy 价值验证

### 目标

判断低频 LLM 战略层是否真的比固定/规则宏观策略更有价值，而不是因为“能产出 policy”就保留。

### 交付

- policy effect attribution：记录策略生效前后窗口和执行层实际消费；
- 固定规则策略、固定 override、LLM MacroPolicy 三组可比；
- 增加 hysteresis/min-hold，禁止 posture/target 高频振荡；
- 对模型调用延迟、失败和成本做完整核算；
- 只有 `incremental_gain_per_cost > 0` 且风险不升才保留生产默认；
- 若没有增益，降级为实验/建议层，不影响确定性主线。

## 8. 2026 Q4 条件路线

这些工作有严格前置条件，不按日历强推。

### 8.1 Contextual Bandit

仅在以下条件满足后启动：

- 已有多个稳定、可解释、合法的宏观策略臂；
- 实验 registry 和自动 guardrail 成熟；
- 至少有跨世界阶段的有效窗口；
- Bandit 只选择宏观配置，不直接输出动作。

### 8.2 监督价值模型

第一版只做 `(state features, legal candidate) → future value/risk` 排序。启动条件：

- decision/outcome 能可靠关联；
- 数据覆盖多个 planner variant 和风险场景；
- simulator calibration 达标；
- 手工 CandidateEvaluator 已形成强 baseline。

模型不得绕过 Planner/Validator，不得直接生成联合动作。

### 8.3 受控自我改进

只自动提出实验或参数补丁：

```text
observe → hypothesis → config/parameter proposal → replay → tournament → report
```

代码修改与生产晋级继续人工审查。框架抽取、公开 benchmark 和 RL 都排在稳定收益闭环之后。

## 9. Issue-ready Backlog

| ID | 优先级 | 轨道 | 任务 | 规模 | 依赖 | 完成定义 |
|---|---|---|---|---|---|---|
| TS-001 | P0 | C | KPI report CLI | M | 无 | JSON+文本、窗口统计、fixtures、确定性 |
| TS-002 | P0 | C | 冻结 v0.2.15 baseline | S | TS-001 | SHA/config/rules/seeds/KPI 全记录 |
| TS-003 | P0 | C | Experiment manifest v1 | S | 无 | schema、loader、错误提示、测试 |
| TS-004 | P0 | B | Named PlannerVariant registry | M | 无 | 复用 PlanProvider/plannerFactory，默认行为零变化 |
| TS-005 | P1 | C | 自动状态/波次文档收口 | S | 无 | 不再每个微修手工同步测试数 |
| TS-006 | P1 | B | CandidateEvaluator v1 | M | TS-004 | 分数 breakdown、无 submit 权 |
| TS-007 | P1 | C | 扩展现有 runAB/ABReport + CLI | M | TS-003/004/006 | 命名 variant、多 seed、分位数、失败 seed 可复现 |
| TS-008 | P1 | B | economy-v1 candidate | M | TS-006 | 回仓周期/空转改善，有场景测试 |
| TS-009 | P1 | B | clear-path-v1 candidate | M | TS-006 | 军事清场 ROI 门禁，有 A-B 场景 |
| TS-010 | P1 | C | production scenario corpus | M | 无 | 死锁/阻塞样本脱敏固化 |
| TS-011 | P1 | B | global worker cost assignment | L | TS-007/010 | 标准窗口收益 ≥10% 候选 |
| TS-012 | P1 | B | economy phase model | M | TS-001/006 | 回本/容量/upkeep/target 显式化 |
| TS-013 | P1 | A/C | specialized Runtime-Golden | L | TS-010 | 四类事件 coverage 达标 |
| TS-014 | P1 | C | calibration gap report | M | TS-013 | hard mismatch/unclassified 门禁 |
| TS-015 | P1 | C | champion/challenger runner | L | TS-007/014 | 自动 STOP/HOLD/PROMOTE 报告 |
| TS-016 | P2 | B/C | MacroPolicy attribution | M | TS-001/015 | 增益、成本、实际消费可归因 |
| TS-017 | P2 | B | policy hysteresis | S | TS-016 | 无高频振荡，sticky/hold 可测 |
| TS-018 | P2 | A | rollback drill closure | S | 稳定版本 | 演练证据，不扩展部署系统 |
| TS-019 | P2 | A | Provider fault injection evidence | M | 无 | circuit telemetry 完整、fallback 正常 |
| TS-020 | P3 | C | Bandit experiment | L | TS-015/016 + 数据门禁 | 只选宏观策略臂 |
| TS-021 | P3 | C | value ranking model | L | 数据+校准门禁 | 只排序合法候选、可回滚 |

规模仅用于拆分：S 应在半天内闭环，M 应在一个工作日左右形成可审查切片，L 必须拆成多个可独立合并的 M。

## 10. 并行地界

为了避免再次相互覆盖，代码地界固定为：

| 轨道 | 主目录 | 不应顺手修改 |
|---|---|---|
| A 可靠性 | `src/app/`、`src/runtime/`、`deploy/`、`scripts/server/` | Planner 行为和模拟规则 |
| B Planner | `src/planning/`、`src/strategies/`、`src/domain/nav.ts` | Supervisor、部署、日志轮转 |
| C 评估 | `src/analysis/`、`src/sim/`、`src/runtime-golden/`、`experiments/` | 生产 submit 链 |
| SDK | `packages/arena-hero-ts/` | 仅上游协议/规则变化时修改 |

跨地界变更先拆契约提交，再由对应轨道消费。禁止一个 PR 同时改部署、Planner、模拟器和进度文档。

## 11. 统一指标

### 11.1 业务主指标

- `net_core_gain_per_100_ticks`；
- `ticks_to_redemption_target_20/30/50`；
- `redemption_ready_rate`；
- `core_resources_at_risk`。

### 11.2 效率指标

- gross deposit / 100 ticks；
- worker idle ratio；
- travel waste ratio；
- cargo blocked ticks；
- target switch rate；
- spawn payback ticks；
- capacity/overflow loss；
- military clearing ROI。

### 11.3 风险与可靠性

必须保持 0：

- wrong tick submit；
- duplicate submit；
- stale candidate executed；
- illegal final plan；
- cross-tenant contamination；
- orphan process；
- credential leak；
- hard Runtime-Golden mismatch。

趋势指标：submit failure、repair、deadline timeout、Core destruction、unit loss、upkeep deficit。

### 11.4 Agent/MacroPolicy

- policy update success/failure/latency；
- policy field consumption rate；
- policy oscillation rate；
- incremental gain per call/cost；
- fixed-rule vs override vs LLM uplift。

## 12. 停止清单

从本计划生效起，默认停止：

1. 因普通小修复立即独立打版本、部署和写一轮 MASTER；
2. 用测试数量、提交数量或“已上线”代替业务收益；
3. 没有 baseline/metric 的 Planner 调参；
4. 先 SSH 看生产、再临时猜修复；优先固化 fixture/scenario 后离线复现；
5. 在 `tenant-runtime.ts`、`deterministic-planner.ts`、`safety-planner.ts` 做无行为目标的大重构；
6. 继续扩展服务器控制面、配置中心或第二套进程管理；
7. per-tick LLM、LLM 直控 submit；
8. 在专项数据不足时做 RL、Transformer 或通用框架抽取；
9. 同时运行多个生产 challenger；
10. 把每次实验流水账塞入 MASTER。

## 13. 每周节奏

### 周初

- 冻结本周 champion、primary metric 和最多三个活跃任务；
- 从 backlog 只拉取一项 A、一项 B、一项 C；
- 明确本周不做事项。

### 日常

- 上午优先能力实现和定向测试；
- 批量模拟/长跑作为独立命令运行，不阻塞下一项本地编码；
- 合并后进入每日 release train；
- 生产只做健康确认或已批准实验，不用生产代替单测和模拟器。

### 周末/波次结束

- 自动生成 champion/challenger 报告；
- 只根据指标决定 promote/hold/drop；
- 更新一次 MASTER 和本计划状态；
- 清理已合并 worktree/远端分支和临时 artifacts；
- 下一周优先解决导致实验不可判定的工具缺口。

## 14. 当前立即开工顺序

```text
TS-001 KPI report
→ TS-003 experiment manifest
→ TS-004 PlannerVariant adapter
→ TS-002 baseline freeze
→ TS-006 CandidateEvaluator
→ TS-007 tournament runner
→ TS-008 / TS-009 candidates
```

A 轨道仅并行关闭 TS-018/TS-019 等已有可靠性缺口，不再抢占 Planner 主序列。

## 15. 成功判据

这份计划成功，不是因为文档完整，而是因为出现以下变化：

- 从发现问题到离线可复现不再依赖多轮生产观察；
- 一项 Planner 改动可以自动与冻结基线比较；
- 一周内能稳定完成多个小型候选，而不是连续追一个生产症状；
- 文档/版本/部署提交占比明显下降；
- 每个发布都能回答“净收益提升多少、风险是否上升、为什么晋级”；
- TS 线在不放宽安全红线的前提下，持续缩短兑换目标所需 Tick。
