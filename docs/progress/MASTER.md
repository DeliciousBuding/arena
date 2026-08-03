# MASTER — Arena 当前进度与门禁

> 当前执行入口。历史设计见 `docs/migration-plan.md`，长期路线见 `docs/roadmap-long-term.md`。
> 最后整理：2026-08-03。代码、运行 manifest、JSONL 证据和 GitHub issue 优先于聊天记录。

## 当前阶段

**W4 收口：单租户 TS 链已真实运行，正在完成 agent-shadow live、DeterministicPlanner live 和仓库 SSOT 门禁。**

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

最新整理时 HEAD：`9814f0f`（之后的文档整理提交不改变运行结论）。

已完成：

- Python / TS 100-tick Golden Replay，未解释硬差异 0；
- DecisionLease、DeadlineBudget、Coordinator、Arbiter、Validator、Safety fallback；
- `DecisionMode` / `SubmissionMode` 两轴，以及 execution / observation 分离；
- Pi `createAgentSession` 真实嵌入，builtin tools 全禁用，仅开放 `arena_plan` / `arena_map`；
- ActiveToolContextSlot、严格工具参数、runId/tick/stateHash 校验；
- 单租户 runtime config、原子单写者锁、manifest、doctor、优雅关闭；
- runtime / decision / outcome / pi JSONL 与递归脱敏；
- DeterministicPlanner 骨架、任务唯一性、sticky assignment 和基础障碍避让。

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
- 结论：合法性观察通过；尚无 live 与收益证据
- 证据：`runs/run-20260802T133504-7b42dd/ts-deterministic/`

## 当前未通过门禁

### 1. Agent-shadow live

首轮 Safety 真提交 + Agent observation 曾出现 Agent 候选全 rejected。诊断显示：

```text
冷启动首调用 12–19s
→ 首 tick 超 soft deadline
→ abort 残留历史
→ session 上下文持续膨胀
→ 后续调用接近 14s
→ candidate tick mismatch / rejected
```

`9814f0f` 已加入 warmup 与周期 rotation，但仍需完成 #4：

- 周期计数必须覆盖所有成功 run，而不是只统计 abort；
- rotation 在 idle/settled 边界执行；
- warmup timeout / failure 必须可观测；
- 重新跑 ≥100 tick live，建议跨过两次 periodic rotation。

在 #4 通过前禁止 hybrid live。

### 2. Deterministic live

完成 #5：

- 单租户 3 → 20 tick live Canary；
- SIGTERM / 锁 / 回滚完整验证；
- Safety 与 Deterministic 多组交替窗口；
- 比较资源收益、单位损失、upkeep、idle/travel waste。

合法性不等于收益，不能只凭 33 tick repair=0 扩到四租户。

### 3. 仓库 SSOT

完成 #6：

- README TS-first；
- MASTER 去除过期 Agent 表；
- `docs/generated/status.md` 与实测同步；
- `gen-status.py` + CI 防漂移；
- 文档 current / plans / reference / legacy 分层。

> 注意：当前 `docs/generated/status.md` 仍显示旧的 TS 测试数量。最新运行提交自报 216/216，但在生成器重新运行并通过 CI 前，不应继续复制测试数字。

## 当前 issues

- #3 — 2026-08-03 下午到午夜 Leader 总控
- #4 — Pi 周期重置与 agent-shadow live 复验
- #5 — Deterministic live 与 Safety A/B
- #6 — 仓库 SSOT 整理
- #7 — W5 Supervisor / health / rollout

已完成的上午总控 #2 已关闭，不再作为进度入口。

## W4 关闭条件

全部满足后才能宣布 W4 完成：

- Safety live 证据：已完成；
- Pi 真实嵌入：已完成；
- agent-shadow live ≥100 tick，跨周期 rotation，P0 全 0；
- Deterministic live Canary P0 全 0；
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
→ 单租户 deterministic / agent-shadow
→ 逐租户扩展
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
