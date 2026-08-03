# Arena 长期路线图（W7-W18）

> 状态：愿景规划（2026-08-03，Leader 总裁决落档）。
> W6（删除 Python 实时 runtime）只是"完成迁移"，不是项目终点。
> 项目定位：**在硬实时截止、部分可观测、长期经济目标和不可信智能组件条件下，
> 能够安全运行、持续评估和自我改进的自主决策系统**。Arena Hero 是第一个真实环境。

## 五层最终形态

```text
可靠实时运行层
    ↓
确定性规划与优化层
    ↓
实验、数据和模拟层
    ↓
机器学习与策略学习层
    ↓
受控自我改进层
```

## W7：生产运行系统（从"能启动"到"长期无人值守"）

- 目标：不重复提交、不漏 Tick、LLM/Provider/网络/配置问题不拖死游戏、可定位、自动降级恢复、安全更新。
- 模块（`packages/arena-agent/src/ops/`）：`supervisor/` `health/` `control-plane/` `config-reloader/` `watchdog/` `incident-recorder/` `rollout-controller/`。
- Supervisor：四租户**进程隔离**（LLM 卡死/内存泄漏只影响单租户；逐租户发布/回滚）。
- Control plane（只控制不绕过提交链）：`GET /health /ready /tenants /tenants/:id/status /recent-decisions`；`POST /tenants/:id/pause|resume|rotate-session|reload-config`。提交仍只能走 `Turn → Coordinator → Validator → SDK submit`。
- 自动降级链：`macro-hybrid → deterministic → safety → emergency → pause`（如 Provider 连续失败 3 次关 LLM 10 分钟；Pi 连续 rotation 退 deterministic；SDK submit 连续失败暂停并报警）。
- W7 闸门：单租户 10,000 Tick 零错误提交；四租户 2,000 Tick 零跨租户污染；SIGTERM 无孤儿；shadow/disabled 子进程可在状态边界明确后有限拉起；live writer 自动拉起需先完成跨进程幂等恢复；热更新错误配置不破坏当前运行；日志零凭据。

### W7 首批实施切片（2026-08-03 规划，hard 层增强）

> 现状盘点：decision-coordinator / decision-lease / deadline-budget / plan-arbiter 已实现且
> 与 2026 业界共识对齐（见文末「对标 2026 前沿」节）。以下三项是盘点出的真实缺口，按性价比排序。

1. **Provider 熔断（circuit breaker，最高优先）**——业界成熟模式（熔断 + 指数退避 + fallback 链）：
   - 状态机：`closed → open（连续失败 ≥3 次，关 LLM 10 分钟）→ half-open（试探 1 次）→ closed / 再 open`；
   - 接入点：Agent runtime 层（startDecision 抛错 / settle outcome=error 计入失败计数），不进 coordinator 决策路径；
   - 熔断打开时决策模式自动降为 `deterministic`（SafetyPlanner 热路径，遥测 `decisionMode: deterministic`）；
   - 遥测字段：`circuit_state / consecutive_failures / last_trip_at`；故障不拖死游戏（每次 tick 仍有确定性计划）。
2. **`raceCandidate` 轮询改事件驱动**——当前 10ms 忙轮询等 soft deadline；改为 Lease 状态变更通知
   （`registry.submit` 时 resolve 等待者），省 CPU、延迟更精确。纯内部实现，行为不变。
3. **submit 阶段超时遥测**——`deadline-budget` 定义了 submit/hard 两段但 coordinator 未强制；
   在 `turn.submit()` 前查 `isExpired(budget, now, "submit")`，超限记 `deadlineOutcome="submit_timeout"`
   并回退 safety 计划（不提交）。价值在遥测完整，非新机制。

**明确不做**（过度工程边界）：
- 形式化验证（Z3/Kani 机器证明 fail-closed）——Unfireable Safety Kernel 论文级手段，对游戏 bot 不划算；
- 双模型竞速 hedging——与本项目「确定性基线 + LLM 增强」的 safety-first 架构相悖，成本收益为负。

## W8：确定性 Planner 竞赛系统

- `PlannerVariant { id, decide }` 多实现候选（safety-v1 / greedy-resource-v1 / global-assignment-v1 / risk-aware-v1 / capacity-aware-v1 / frontier-balanced-v1）。
- CandidateEvaluator 多目标评分（deposit − unit_loss − upkeep − spawn_investment − travel_waste − congestion − target_delay），输出 breakdown 作调试与 ML 训练标签。
- 策略锦标赛：同状态跑全部 Planner，先记录不执行。
- W8 闸门：≥3 组交替窗口、总计 ≥3,000 Tick、无可靠性退化、`core_resource_gain_per_100_ticks` 提升 ≥10%、`ticks_to_redemption_target` 显著下降。**若无法提升就继续优化算法，不上 ML 掩盖问题。**

## W9：数据平台与实验操作系统

- 三种日志分离（以 `processRunId + tenantId + tick` 关联）：
  1. **Runtime Trace**（runId/deadline/latency/abort/rotation/submit result/lease rejection/health）；
  2. **Decision Trace**（state features/planner candidates/scores/LLM directive/arbiter/validator repairs/final plan）；
  3. **Outcome Trace**（harvest/deposit/spawn/heal/repair/upkeep/unit death/overflow/next-state delta）。
- 目录：`runs/<processRunId>/{manifest.json, runtime.jsonl, decisions.jsonl, outcomes.jsonl, snapshots/}`；冷数据压 Parquet 供 Python/DuckDB 分析；分析数据不塞业务 SQLite。
- Experiment Registry：每次策略变化带 `experimentId/gitSha/configHash/plannerVersion/rulesVersion/hypothesis/primaryMetric/guardrails`；实验不能凭"看起来不错"合并。
- 反事实边界（长期保留）：Replay 验证兼容性、Shadow 验证合法性、线上 A/B 比较真实收益、只有模拟器可评估反事实。

## W10：Arena Digital Twin（高保真模拟器）

- `sim/`：`rules/ state/ movement/ economy/ combat/ resources/ visibility/ opponents/ validation/`。
- 必须复现服务端结算顺序：self-destruct → capacity shrink → upkeep → movement → Core move → Beacon → harvest/deposit → combat → heal → Core action → respawn → resource refill。
- 规则 SSOT：`rules-v0.11.json` 版本化，Planner/Validator/Simulator/Prompt/文档同源。
- 持续校准：真实 state + 实际 plan → 模拟器预测 → 与下一真实 state 对比，差异分类（可见性/对手动作/refill 不可预测/规则误解/模拟器 bug）。
- 模拟器闸门：己方动作合法性一致率 100%；已知确定性事件一致率 ≥99.9%；可解释差异率 100%；规则版本绑定生产；规则变更自动失效旧模型。

## W11：Contextual Bandit 与自动调参

- 策略参数离散化为有限臂（workerTarget/reserveResources/exploreWeight/beaconPolicy/combatPolicy）。
- UCB / Thompson Sampling；Bandit 只选宏观配置不输出动作。
- 安全探索：四租户分工（A 稳定 baseline / B 保守实验 / C 中风险 / D shadow-only）；触发 guardrail 自动淘汰。

## W12：监督学习价值模型

- 只做 `(state, candidate_plan) → expected future value`（未来 20 Tick 净资源/50 Tick 目标概率/死亡概率/Core 风险），不直接训练动作模型。
- LightGBM/XGBoost 先行（表格特征、可解释、易回滚），不先上 Transformer。
- 生产位置：规则 Planner 生成合法候选 → Value Model 排序 → 安全过滤 → 选最高分（模型无能力生成非法动作）。
- 晋级闸门：离线 ranking 显著优于手工评分；shadow 无延迟问题；线上交替窗口提升 ≥3%；安全指标无退化；漂移可检测。

## W13：模仿学习与离线 RL

- Behavior Cloning：强 Planner 的 state→action 训练轻量策略（快速候选/模拟器 rollout/策略压缩/RL 初始化）。
- Offline RL 只在覆盖足够广时尝试，防 extrapolation error/过度乐观/reward hacking/旧策略偏差；第一版仍只输出宏观决策或候选评分。

## W14：强化学习与自博弈

- 分层 RL：高层（模式/组成/风险/探索区域/Core 迁移方向）由 RL 选，低层（Worker 分配/路径/冲突/射击）确定性；不让 RL 直接输出全部单位联合动作。
- 对手族多样化（resource-greedy/core-rusher/beacon-focused/defensive/randomized/historical-policy）+ Domain Randomization。
- RL 上线闸门：模拟器超越 deterministic ≥10%；OOD 不崩溃；Safety shield 拦截率低；shadow 合法性 100%；单租户 canary 无可靠性退化；线上收益扣除推理成本为正。

## W15：受控自我改进

- 严格流水线：`Observer → Hypothesis Agent → Patch/Config Proposer → Replay → Simulator tournament → Static gates → Shadow → Canary → Promotion`。
- 早期仅自动改：Planner 参数/Bandit 策略/Prompt/权重/实验配置；**代码修改仍需人审**。
- LLM Research Agent 输出带证据的假设（hypothesis/evidence/proposedChange/expectedImpact/risk/evaluationPlan），系统自动跑实验但不跳过 promotion gates。

## W16：四租户协同智能（Fleet）

- 可共享：永久障碍/已探索区域/资源统计/敌方 Core owner/战略实验结果（知识层）。
- 不可混淆：当前己方单位/资源/可见敌人/租户 private TickState/Lease/CandidateSink。
- 共享地图只能是知识层，不能变共享可变实时状态；先确认规则允许性，避免破坏公平性。

## W17：通用框架抽取（Arena → TokenDance）

- 提炼 `@tokendance/decision-runtime / decision-lease / hedged-planner / experiment-trace / policy-evaluator`。
- 通用能力：deadline-aware agent、预计算 fallback、候选 Lease、迟到结果隔离、session rotation、确定性基线 + LLM hedge、安全灰度、决策审计。
- 核心卖点：**不可信、慢速、随机的 Agent 如何安全参与有时限的真实决策系统**。抽象稳定前不合并仓库。

## W18：公开成果

- 工程：成熟开源系统（SDK/实时 Runtime/确定性 Planner/模拟器/实验平台/可观测性/训练接口）。
- Benchmark：Arena Decision Benchmark（合法动作率/deadline 成功率/stale action rate/长期资源效率/安全退化/LLM 成本/泛化）。
- 研究课题：hard-deadline hedged agent decision；LLM macro-policy over deterministic planners；safe online policy improvement；counterfactual evaluation under partial observability；multi-agent fleet learning。

## 长期统一指标

- 可靠性：wrong_tick_submit=0 / duplicate_submit=0 / stale_candidate_executed=0 / illegal_final_plan=0 / orphan_process=0。
- 效率：ticks_to_redemption_target / core_resource_gain_per_100_ticks / gross_deposit_per_100_ticks / payback / worker_idle_ratio / travel_waste_ratio。
- 风险：unit_loss_cost / core_destruction_rate / upkeep_deficit_rate / overflow_loss / submit_failure_rate。
- Agent：candidate_accept_rate / execution_rate / repair_rate / soft_timeout_rate / selection_timeout_rate / cost_per_100_ticks / incremental_gain_per_dollar。
- 学习系统：offline ranking accuracy / sim-to-real gap / promotion success rate / rollback rate / OOD degradation。

## 阶段门禁总表

| 阶段 | 晋级条件 |
|------|----------|
| 真机 Safety | 20 Tick 零 P0 |
| 单租户稳定 | 1,000 Tick 零错误提交 |
| 多租户 | 单租户 10,000 Tick soak |
| ResourcePlanner | 3,000 Tick、收益提升 ≥10% |
| Macro LLM | 扣除调用成本后仍有正增益 |
| Value Model | 线上提升 ≥3%，风险不升 |
| Bandit | 自动策略选择稳定优于固定配置 |
| Simulator | 已知确定性事件一致率 ≥99.9% |
| RL | 模拟器超越 deterministic ≥10%，OOD 通过 |
| 自动晋级 | Shadow + Canary + guardrail 全通过 |

## Leader 长期优先级（固定顺序，不能反）

```text
1. 正确性 → 2. 可恢复性 → 3. 可观测性 → 4. 确定性算法收益
→ 5. 数据质量 → 6. 模拟器真实性 → 7. 机器学习 → 8. 强化学习
→ 9. 自动自我改进 → 10. 通用平台化
```

正确路线：**先安全实际运行 → 再比 baseline 多赚钱 → 再形成可靠数据 → 再建立可校准模拟器 → 再学习价值函数 → 最后才做 RL 和自我改进**。

## 对标 2026 前沿（2026-08-03 调研验证）

> 以下对照基于对当前 hard 层实现（decision-coordinator / decision-lease / deadline-budget /
> plan-arbiter）的代码盘点 + Web 调研（Unfireable Safety Kernel arXiv 2606.26057、
> Deterministic Governance Kernels（Zylos 2026-03）、hedged requests（Dean & Barroso Tail at Scale）、
> HiMAC/HiPER 分层宏微 RL）。结论：**本路线方向与 2026 业界共识一致，无需结构性转向**。

| 本路线/实现 | 对应前沿概念 | 结论 |
|---|---|---|
| SafetyPlanner 预计算 + Lease + deadline race | Unfireable Safety Kernel：进程隔离/前置强制/fail-closed/外部化证据 | 已对齐前三项；形式化证明（Z3/Kani）对 bot 属过度工程，明确不做 |
| Pi 永不持提交权，arena-agent 唯一 submit | Deterministic Governance Kernel：治理者绝不被 LLM 自我治理 | 已对齐 ✅ |
| DecisionLease 三重校验（runId/tick/stateHash） | LLM idempotency key + 请求去重 | 比多数生产方案更严（含 stateHash） |
| 确定性基线 + LLM 增强（非双模型竞速） | hedged requests 的 safety-first 变体 | 本路线更优：实时决策系统应保底不竞速 |
| W12-W14 宏观 LLM + 低层确定性 + 分层 RL | HiMAC / HiPER：macro planning + micro execution | 方向一致，按 W9 数据 + W10 模拟器前置推进 |

**研究课题定位**（W18 对外口径）：本项目实际在做的是
`hard-deadline hedged agent decision with deterministic governance kernel`——
这是 2026 年 agent 生产化的核心开放问题，Arena 是第一个真实环境。
