# MASTER — Arena 当前进度与门禁

> 当前执行入口。历史设计见 `docs/migration-plan.md`，长期路线见 `docs/roadmap-long-term.md`。
> 最后整理：2026-08-03 16:30。代码、运行 manifest、JSONL 证据和 GitHub issue 优先于聊天记录。

## 当前阶段

**W4 收口：经济闭环已跑通（HARVEST → cargo → DEPOSIT → Core 增长），t1 deterministic live burn-in 进行中。**

固定优先级：

```text
正确性
→ 可恢复性
→ 可观测性
→ 确定性算法收益
→ 数据质量
→ 模拟器
→ ML / Bandit
→ RL
```

## 当前主干事实

最新整理时 HEAD：`4f5151a`（本地 = 远端，无未推送提交）。

已完成：

- Python / TS 100-tick Golden Replay，未解释硬差异 0；
- DecisionLease、DeadlineBudget、Coordinator、Arbiter、Validator、Safety fallback；
- `DecisionMode` / `SubmissionMode` 两轴，以及 execution / observation 分离；
- Pi `createAgentSession` 真实嵌入，builtin tools 全禁用，仅开放 `arena_plan` / `arena_map`；
- ActiveToolContextSlot、严格工具参数、runId/tick/stateHash 校验；
- 单租户 runtime config、原子单写者锁（`wx` / O_CREAT|O_EXCL）、manifest、doctor、优雅关闭；
- runtime / decision / outcome / pi JSONL 与递归脱敏；
- **经济闭环（2026-08-03 真机验证）**：有界 BFS 绕障寻路（修复长墙两格振荡）、资源格全局唯一分配、无资源时八方向分层巡逻、跨 Tick 资源记忆、cargo 回仓状态机；
- **经济遥测**：MOVE/HARVEST/DEPOSIT/WAIT 动作数、可见资源格数、cargo Worker 数/总量、意图混合（intent mix）、探索覆盖、submit 失败明细、失败动作归因（prior plan attribution）。

### 近期提交（3c3161a → 4f5151a，10 个）

```text
4f5151a feat(ops): add executable burn-in quality gates
5db5313 perf(planner): expand patrol through layered rings
d78df90 perf(planner): expand patrol coverage to eight directions
511c6d9 fix(runtime): synchronize before first live submission
75249ed fix(map-store): retry concurrent WAL initialization
5964354 feat(telemetry): measure intent mix and exploration spread
2d3bc72 fix(planner): resolve cell capacity before submit
4e78224 feat(telemetry): retain submit failure details
9baeb1f feat(runtime): add bounded graceful burn-in runs
40989b9 feat(telemetry): attribute failed actions to prior plans
```

## 已通过的线上门禁

### TS Safety Canary

- 租户：t1
- shadow：10 tick
- live：45 tick
- 结论：P0 红线全 0
- 证据：`runs/run-20260802T133504-7b42dd/ts-live-canary/`

### Agent shadow 观察

- 114 tick
- candidate rate：96.5%
- p95：10.1s
- rotation：0
- 结论：观察模式门槛通过，但不等于 live 门禁通过
- 证据：`runs/run-20260802T133504-7b42dd/ts-agent-shadow/`

### Deterministic 观察

- 租户：t2
- 33 tick
- blocked move 系统性问题修复后 repair=0
- 结论：合法性观察通过
- 证据：`runs/run-20260802T133504-7b42dd/ts-deterministic/`

### Deterministic live 经济闭环 Canary（2026-08-03 新增）

第一轮（run `7a0f9b0a`，tick 43974→44009）：

| 指标 | 结果 |
|---|---|
| accepted | 37/37 |
| rejected | 0 |
| repair | 0 |
| HARVEST_SUCCEEDED | 3 |
| DEPOSIT_SUCCEEDED | 2 |
| Core 资源 | 6 → 8 |

完整链路已证明：巡逻发现资源 → 前往 → HARVEST → cargo=1 → 绕障回 Core → DEPOSIT → Core 增长。

第二轮效率（run `f38102de`，commit 3c3161a，tick 44010→44032）：

| 指标 | 结果 |
|---|---|
| accepted | 14/14 |
| decisionSource | deterministic |
| deadlineOutcome | not_applicable |
| WAIT | 0 |
| DEPOSIT_SUCCEEDED | 1 |
| Core 资源 | 8 → 9 |

修复：一个资源格只分配一个 Worker，其余继续巡逻（不再 WAIT）。

> 移动失败率对比（修复价值量级）：旧导航 39.7%（4450 次移动 1765 次失败）→ 新导航 run1 0%、run2 1.8%。

### t1 deterministic live burn-in（进行中）

- 活跃进程：pid 39064，run `9ec7b2c7`，gitSha `4f5151a`，16:12:29 启动
- 观察点：tick 44322+，Core 资源 10，visibleResourceCellCount 0→1（巡逻重新发现资源）
- 门禁：accepted 100%、repair=0、无连续 20 tick 经济停滞、移动失败率低位

## 当前未通过门禁

### 1. Agent-shadow live（架构暂停）

`#8` 裁决：per-tick 完整 LLM 决策（冷启动 22.8s）与 15s 游戏窗口结构性不兼容。agent-shadow live / hybrid live 禁止，直至离线延迟基准与 MacroPolicy 转向完成。`#4` 生命周期修复（b9515aa）已完成但**不自动解锁**。

### 2. 100 Tick burn-in 完成

t1 正在积累 burn-in 证据。完成后需要：

- 移动冲突与失败原因分析（unit 下一格预约）；
- 逐租户迁移（先 t2，再 t3/t4，不四租户同时开闸）。

### 3. MacroPolicy（#8 第二阶段，暂停中）

- LLM 只异步输出战略指令（accumulate target / worker target / reserve / explore radius / defensive mode），每 20–50 tick 或事件触发；
- LLM 永不直接控制每 Tick 单位动作；
- 离线延迟 benchmark 未开始（暂停，优先经济闭环）。

### 4. 仓库 SSOT

完成 #6：

- README TS-first；
- MASTER 去除过期 Agent 表；
- `docs/generated/status.md` 与实测同步；
- `gen-status.py` + CI 防漂移；
- 文档 current / plans / reference / legacy 分层。

## 当前 issues

- #3 — 2026-08-03 下午到午夜 Leader 总控
- #4 — Pi 周期重置（已提交 b9515aa，审计项待清理）
- #5 — Deterministic live 与 Safety A/B（经济闭环已过，A/B 收益验证待做）
- #6 — 仓库 SSOT 整理
- #7 — W5 Supervisor / health / rollout
- #8 — Per-tick LLM 硬实时不成立 → 延迟基准 + MacroPolicy 转向

已完成的上午总控 #2 已关闭，不再作为进度入口。

## W4 关闭条件

全部满足后才能宣布 W4 完成：

- Safety live 证据：已完成；
- Pi 真实嵌入：已完成；
- Deterministic live Canary P0 全 0：已完成（两轮）；
- **t1 100 Tick burn-in 完成（进行中）**；
- 移动失败率低位 + 失败归因分析；
- runtime / decision / outcome / pi 证据可关联；
- README / MASTER / generated status 不冲突；
- clean clone 全量门禁通过；
- Python 回滚链仍可用。

W4 关闭不代表允许 hybrid，也不代表允许删除 Python。

## W5 开闸

W5 只做生产运行层：

```text
per-tenant process supervisor
→ liveness / readiness / degraded state
→ 自动降级
→ 逐租户 canary / promote / rollback
→ 四租户 soak
```

具体任务见 #7。四租户 live 迁移顺序固定：

```text
单租户 safety
→ 单租户 deterministic（t1 已跑，burn-in 中）
→ 逐租户扩展（t2 → t3 → t4，逐个切换）
→ 长期 soak
→ hybrid 独立门禁
→ W6 才讨论 Python 删除
```

## 全量门禁

```bash
npm run check
npm test
npm run schema:check
npm run replay:check
uv run pytest tests/ -q
uv run python scripts/gen-status.py --check
```

测试命令必须有外层 timeout；超过 2 分钟无输出即终止并调查 open handle。

## 永久红线

```text
wrong_tick_submit = 0
duplicate_submit = 0
stale_candidate_executed = 0
illegal_final_plan = 0
orphan_process = 0
credential_in_logs = 0
```

- 同一租户 Python / TS 只能一个 live writer；
- 任何 P0 出现立即停止该租户 TS，确认无提交后回滚；
- 不用单个漂亮窗口宣称策略收益；
- 不把 shadow 合法率当作生产收益；
- 不在四租户稳定 soak 前删除 Python；
- 不在模拟器校准前启动 RL 主线。
