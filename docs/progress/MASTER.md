# MASTER — Arena 当前进度与门禁

> 当前执行入口。历史设计见 `docs/migration-plan.md`，长期路线见 `docs/roadmap-long-term.md`。
> 最后整理：2026-08-03 22:30。代码、run manifest、JSONL、Runtime-Golden 与 Git 提交优先于聊天记录。

## 当前阶段

**W4 deterministic 生产迁移与 Digital Twin / Runtime-Golden 融合已完成。下一阶段是 W5 supervisor/长期 soak 与异步 MacroPolicy；per-tick LLM live 仍保持关闭。**

固定优先级：

```text
正确性 → 可恢复性 → 可观测性 → 确定性收益 → 数据质量
→ 模拟器校准 → 安全灰度 → MacroPolicy → ML / Bandit → RL
```

## 当前主干事实

已完成：

- TS SDK wire/domain 归一化、Golden Replay、schema 与协议关系约束；
- DecisionLease、DeadlineBudget、Coordinator、Arbiter、Validator、Safety fallback；
- 单租户 runtime、原子 single-writer lock、manifest、doctor、优雅关闭与三流遥测；
- DeterministicPlanner 经济闭环：BFS 绕障、资源唯一分配、分层巡逻、跨 Tick 资源记忆、cargo 回仓、容量裁决；
- 动态移动争用退避：`MOVE_CONTESTED` 等只对对应 actor 短期冷却，不污染永久地图；
- 最低 Worker 自恢复：Worker <2 时允许紧急补员；正常阶段继续积累，Core heal/repair 保留；
- S0–S12 / P06 / P12 Digital Twin：movement/economy/visibility、combat、Beacon、Core migration、respawn、Planner 闭环、A/B、benchmark、calibration；
- S8b Runtime-Golden recorder：默认关闭、submit 后旁路、fail-open、四层 integrity hash；
- `calibrate-dataset`：hash/path/rules 绑定、taxonomy、硬差异与已知事件 ≥99.9% 门禁；
- 生产 deterministic、Runtime-Golden 与扩展模拟器 resolver 已融合进 `main`；
- MapStore WAL 重试在 Node 24 下改用对齐的 `SharedArrayBuffer(4)`，多进程并发写连续 5 轮通过。

## 真机迁移证据

### t1 Canary / 经济闭环

- run `7a0f9b0a…`：37/37 accepted、3 harvest、2 deposit、Core 6→8；
- run `f38102de…`：14/14 accepted、WAIT=0、1 deposit、Core 8→9；
- 证明巡逻发现资源 → HARVEST → cargo → 绕障返航 → DEPOSIT 的完整链路。

### t1–t4 严格 100 Tick burn-in

| 租户 | run | accepted | harvest/deposit | Core Δ | failed | WAIT ratio | P95 |
|---|---|---:|---:|---:|---:|---:|---:|
| t1 | `825f47a9…` | 100/100 | 4 / 4 | +4 | 0 | 0% | 25.92 ms |
| t2 | `901dba1a…` | 100/100 | 3 / 2 | +2 | 0 | 0.25% | 19.05 ms |
| t3 | `21d1556a…` | 100/100 | 1 / 1 | +1 | 0 | 0% | 14.07 ms |
| t4 | `f7a14164…` | 100/100 | 1 / 1 | +1 | 0 | 0% | 2.74 ms |

四份报告均 `passed=true`，每份包含 1 Tick startup sync、100 次 live submit 和最终 outcome drain；合计 400/400 accepted、0 rejected、0 repair、0执行失败，运行结束后无锁与孤儿进程。t1 报告：`runtime/t1/migrations/20260803-final-pass-825f47a9-11e7-4324-ba1d-11d4fb66bc40.json`。

## Runtime-Golden 真机证据

- recorder run：`26600fea-e8c7-45da-98e8-5a4bc03919f9`；
- source SHA：`93a63e3`；
- 3/3 live submit accepted，cases=3、recorder errors=0；
- dataset 四层 hash、路径、rulesVersion、source/config hash 全部验证；
- known deterministic events：6/6（100%，门槛 99.9%）；
- hard mismatch cases=0，unclassified differences=0；
- 16 条差异全部归类为 `EXPECTED_UNKNOWN`（对手 Plan、Beacon 可见性、server-secret refill）；
- real-data calibration report：`runs/sim/runtime-golden-t3-26600fea/calibration-dataset-report.json`。

这批数据同时发现并修复：SDK optional-nullable wire 字段未归一化、recorder 单 case 失败污染 pending、2:3 斜率 supercover 误收终点旁格。

## 当前运行态

- t1–t4 验证进程均已停止；
- 无 tenant lock、无 orphan Arena writer；
- 未配置长期常驻 supervisor，避免把验证脚本误当生产守护；
- Python 回滚资产仍保留，但不得与同租户 TS live writer 并行。

## 仍未开闸

### Per-tick LLM / hybrid live

`#8` 结论不变：完整 LLM per-tick 决策冷启动/尾延迟与 15s 游戏窗口结构性不兼容。Agent-shadow 可用于观察，hybrid live 不因 deterministic/模拟器完成而自动解锁。

### MacroPolicy

后续只允许异步输出低频战略参数（资源储备、Worker 目标、探索半径、防御模式等），每 20–50 Tick 或事件触发；LLM 永不直接控制每 Tick 单位动作。

### W5 Supervisor

下一阶段只做生产运行层：

```text
per-tenant supervisor → liveness/readiness/degraded
→ 自动降级 → canary/promote/rollback → 四租户长期 soak
```

## 全量门禁

```bash
npm run check
npm test
npm run schema:check
npm run replay:check
uv run pytest tests/ -q
uv run python scripts/gen-status.py --check
uv run python scripts/docs_health.py --check
```

Runtime-Golden：

```bash
npm run sim:calibrate-dataset -w packages/arena-agent -- \
  --manifest runtime/t3/calibration/26600fea-e8c7-45da-98e8-5a4bc03919f9/manifest.json \
  --run-id runtime-golden-t3-26600fea --force
```

## 永久红线

```text
wrong_tick_submit = 0
duplicate_submit = 0
stale_candidate_executed = 0
illegal_final_plan = 0
orphan_process = 0
credential_in_logs = 0
```

- 同一租户只能有一个 live writer；
- P0 出现立即停止、确认无提交后回滚；
- 不把 `INCONCLUSIVE` 当 MATCH；
- 不把单个漂亮窗口当长期收益；
- 不在长期 soak 前删除 Python 回滚链；
- 不在 Runtime-Golden 覆盖充分前启动 RL 主线。
