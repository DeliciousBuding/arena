# TS 架构（主线）

> 当前目标架构权威文档（2026-08-03 建立）。TS 编排层是本项目主线；Python 版架构
> 见 `ARCHITECTURE.md`（退役参考）。迁移方案与切片见 `migration-plan.md`，
> 长期路线见 `roadmap-long-term.md`，进度与门禁以 `docs/progress/MASTER.md` 为准。

最后更新：2026-08-05

## 三层边界（不可违反）

```text
Pi（Agent loop / 模型 / 会话 / 战略上下文）
        ↓ 产生候选决策（arena_plan / arena_map 工具）
arena-agent（校验、裁决、限时、回退、submit 权）
        ↓ 权威 CommandPlan
arena-hero-ts（wire 协议 / WS / Turn / 提交）
```

- Arena Hero 当前状态是唯一权威事实；
- **Pi 永远不应持有游戏提交权**——`arena_plan` 只向当前 DecisionLease 提交候选，不直接操作游戏；
- arena-agent 保留最终合法性校验、deadline 裁决和 submit 权；
- Python 实时 runtime 已删除；`reference/arena-hero-python/` 只用于追上游对照。

## 仓库结构

| 路径 | 职责 |
|------|------|
| `packages/arena-hero-ts/` | TS SDK：wire schema 单源（TypeBox）→ `contracts/generated/*.schema.json`；WS client；Turn builder |
| `packages/arena-agent/` | 编排层：domain/ + runtime/ + strategies/ + telemetry/ + map-store |
| `packages/pi-arena/` | Pi 原生 extension：`arena_plan` / `arena_map` 工具（registerTool） |
| `reference/arena-hero-python/` | 官方 Python SDK 镜像（追上游对照，不执行） |
| `src/arena_bot/` | 已删除；仅 Git 历史保留迁移取证 |

## 每 Tick 决策链路（W4 coordinator 路径）

```
client.turns() → Turn（SDK）
  → reduceTurn → TickState（immutable，排序+freeze）
  → DecisionCoordinator.decide(state)
      ├─ SafetyPlanner 预计算（确定性基线）
      ├─ Agent runtime（可选）经 DecisionLease 提交候选
      ├─ deadline race（soft deadline 前接受合法候选）
      ├─ PlanArbiter 合成（hybrid/emergency）
      └─ expired/cancelled → 立即 Safety 兜底
  → validatePlan（语义校验 + per-action repair）
  → planToCommandPlan → turn.replace → turn.submit()
  → runtime / decision / outcome JSONL 遥测
```

## 决策指挥链（2026-08-06，死循环闭环五层）

低频策略层与高频执行层之间插入了完整指挥链。每层只改 `focusRegion` 一个字段
（最小干预，让执行层既有回仓巡逻逻辑自行恢复）：

```
policy(LLM 低频 32 tick, 独立 Pi session)
  → discipline(PolicyDiscipline 上游纪律：连续 2 次超距焦点 → 禁言 128 tick)
  → recovery(StallRecovery 下游自愈：idle→recovering→escalating，结果反馈 policy)
  → 执行层(SafetyPlanner maxFocusDistance 防呆 + clearPath 清障)
  → KPI(自愈成功率/纪律事件/恢复迁移统计)
```

核心运行时组件（`packages/arena-agent/src/runtime/`）：

| 组件 | 职责 |
|------|------|
| `loop.ts` | 主循环 `runTenantLoop`：turns() → 决策 → 提交；startupSync / outcomeDrain 边界 |
| `decision-lease.ts` | 单次决策租约：runId/tick/stateHash/deadline 三重校验 |
| `decision-coordinator.ts` | W4 决策核心：Safety 预计算 + deadline race + settle（唯一正式路径） |
| `plan-arbiter.ts` | 候选合成（hybrid / emergency） |
| `lease-registry.ts` | runId 精确索引 + 状态机 + 有界清理 |
| `deadline-budget.ts` / `clock.ts` | 时间预算与 FakeClock（测试用） |
| `state-hash.ts` | TickState 内容哈希（lease 校验用） |
| `decision-types.ts` | AgentDecisionRequest/DecisionResult 等契约 |
| `stall-detector.ts` | 死循环 5 模式检测（cargo_blocked/no_production/patrol_only/focus_exile/capacity_wait_loop），16 tick rising-edge，256 tick 开局宽限 |
| `stall-recovery.ts` | 自愈状态机（idle→recovering→escalating；outcome 三态 recovered/failed/expired；failureRounds 跨会话累计） |
| `policy-discipline.ts` | 策略层纪律（连续坏焦点 → 禁言 focusRegion 强制 null；合法焦点清零） |
| `macro-policy-orchestrator.ts` | 低频策略周期（32 tick）+ sticky 失败保持 + 重生覆盖 |

领域层（`packages/arena-agent/src/domain/`）：

| 组件 | 职责 |
|------|------|
| `state-reducer.ts` | Turn → 规范化 TickState（权威适配层） |
| `model.ts` | Plan / TickState / UnitAction / CoreAction 类型 |
| `nav.ts` | 有界 BFS 最短路导航（margin 4/8/16/32，绕长墙防振荡） |
| `world.ts` | 视野记忆：障碍/资源/敌人跨 Tick 记忆 |
| `plan-validator.ts` | 语义校验 + per-action repair |
| `phase-machine.ts` | 阶段机（early_expansion/balanced/military） |

策略层（`packages/arena-agent/src/strategies/`）：

- `safety-planner.ts`：确定性 Safety 基线（spawn / 巡逻 / 回仓状态机 / 守备）；
  `SafetyPlannerConfig`：`maxFocusDistance`（focus 防呆半径，默认 32）+ `clearPath`
  （清障开关，TS-009 候选）；变体注册在 `sim/tools/planner-variants.ts`；
- DeterministicPlanner（经济闭环）：复用 SafetyPlanner，WorkerTaskPlanner 负责资源格全局唯一分配；
- `DecisionMode` / `SubmissionMode` 两轴独立，不再用单一 `shadow:boolean`。

模拟级验证（`packages/arena-agent/src/sim/harness/episode.ts`）：

- `EpisodeConfig.policyProvider`：每 tick 策略决策器（模拟 LLM 低频决策/坏焦点模式；
  null = 保持上次）——discipline/recovery 生产机制可在模拟器复现
  （`test/command-chain-sim.test.ts`：无防呆执行层下 worker 留守 vs 被支走的位置断言）。

参数优化（neat-freak 闭环）：`packages/arena-agent/scripts/param-scan.mts` 网格扫描
（maxFocusDistance/clearPath/exploreRadius/threatEnemyDistance，2 seeds × 双场景），
输出排序 + 可注册配置候选。扫描结论：clearPath=true 稳定 +1 资源（不改生产默认，
注册为 clear-path-v1 候选变体）。

模拟器真实性（2026-08-06）：
- 官方 refill 是 server-secret（rules manifest constraints.refill.status=server-secret）——
  P13-refill-policy 双路径：无配置 → server-secret unknown note（零回归）；有配置
  （`EpisodeConfig.refill`）→ 按 cadence 补回原始资源格 + approximate note（近似，不伪装官方）。
- 策略搜索引擎：`scripts/strategy-search.mts` v3（两阶段：单人经济全网格 27 组合 +
  top4 对打验证）、`scripts/military-ratio-experiment.mts`（军事比例聚焦）。
- 实证结论（refill 下）：militaryRatio 0.3-0.4 拐点、>0.5 纯损耗（prompt 约束已落地）；
  workerTarget 8 平衡区（6 保守、10 upkeep 负担）。

## 关键设计约束

- **单写者锁**：同一租户只能有一个 live writer（`wx` / O_CREAT|O_EXCL 原子创建）；
- **DecisionLease 是第二道隔离**：Provider stream 必须响应 AbortSignal，lease 仍校验 runId/tick/stateHash；
- **决策确定性**：同一输入 state → 同一 plan（Golden Replay / Differential Record 门禁保护）；
- **Telemetry**：runtime / decision / outcome / pi JSONL（append-only），递归脱敏，凭据不落盘；
- **MapStore**：SQLite WAL 跨进程增量同步（障碍/盟友知识层），worker 线程使用，不阻塞主 event loop。

## 验证与门禁

```bash
npm run check                # tsc --noEmit（TypeScript 7 原生 Go 编译器）
npm test                     # 两包测试（node --test --test-force-exit，Node 24 原生跑 TS）
npm run schema:check         # contracts 契约零漂移
npm run replay:ts            # 冻结 W3 fixture 的 TS 回放
python scripts/gen-status.py --check
python scripts/docs_health.py --check
```

测试数以 `docs/generated/status.md`（gen-status 生成）为准，不在文档手工维护。
