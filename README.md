# Arena Hero Autonomous Decision System

这是 Arena Hero 的单仓自主决策工作区：**TypeScript SDK + 实时决策运行时 + 确定性 Planner + Pi/LLM 候选层 + 遥测与实验基础设施**。

当前目标是安全、稳定地积累 Core 资源，并把每次策略升级建立在真实线上证据上。

> 当前目标架构是 **TS-first**。`src/arena_bot/` Python 运行时仍用于多租户生产和回滚，待 W6 门禁通过后退役；它不再承载新策略开发。

## 当前状态

已完成：

- TS SDK 与 Python 100-tick Golden Replay 语义对齐；
- deadline-aware DecisionCoordinator、Lease、Validator、Safety fallback；
- Pi `createAgentSession` 真实嵌入，内置工具禁用，只开放 `arena_plan` / `arena_map`；
- 单租户运行入口、单写者锁、manifest、doctor、runtime/decision/outcome JSONL；
- TS Safety 单租户真机 Canary；
- agent-shadow 与 DeterministicPlanner 的线上观察。

仍在门禁中：

- agent-shadow live 在 warmup / session rotation 修复后的重新验收；
- DeterministicPlanner 真机 Canary 与 Safety A/B 收益验证；
- W5 多租户 Supervisor 与渐进发布；
- W6 Python runtime 删除。

当前进度和证据以 [`docs/progress/MASTER.md`](docs/progress/MASTER.md) 为准；中长期路线见 [`docs/roadmap-long-term.md`](docs/roadmap-long-term.md)。

## 目标运行链

```text
Arena state
  → TS SDK reducer
  → baseline planner（Safety / Deterministic）
  → 可选 Pi/LLM observation 或 candidate
  → Lease + Arbiter + Validator
  → final Plan
  → TS SDK submit
  → runtime / decision / outcome telemetry
```

### 安全不变量

- 同一租户只能有一个 live writer；
- wrong-tick、stale、duplicate candidate 永不执行；
- LLM 超时、失败或 session rotation 时立即回退 baseline；
- `agent-shadow` 中真实执行始终是 Safety，Agent 只记录 observation；
- 任何 P0 出现立即停止该租户 TS，确认无残留提交后回滚；
- 凭据只从环境变量读取，不进入配置、manifest、日志或 issue。

## 决策模式

| Decision mode | Submission mode | 行为 |
|---|---|---|
| `safety` | `live` | SafetyPlanner 真提交 |
| `deterministic` | `disabled` | DeterministicPlanner 只观察 |
| `deterministic` | `live` | 通过独立 Canary 后才允许真提交 |
| `agent-shadow` | `live` | Safety 真提交，Agent 只记录候选和延迟 |
| `hybrid` | `live` | Agent/Hybrid/Safety 仲裁后真提交；当前仍需独立门禁 |

`DecisionMode` 与 `SubmissionMode` 是两个独立轴；不要再使用一个 `shadow:boolean` 同时表达“不提交”和“Agent 不掌权”。

## 仓库结构

```text
packages/arena-hero-ts/       TS SDK、wire schema、Turn/client 与契约产物
packages/arena-agent/         实时编排、Planner、Pi adapter、运行入口与遥测
  └─ src/sim/                 本地光速模拟器（Digital Twin，W10；分支 sim-digital-twin）
reference/arena-hero-python/  官方 Python SDK 镜像，仅用于上游对照
src/arena_bot/                legacy Python runtime，生产回滚链，W6 后删除
fixtures/differential/        Python/TS Golden Replay fixture
scripts/                      schema、replay、status 与离线工具
experiments/                  legacy Python 实验配置，迁移期间保留
runs/                         本地运行证据，gitignored
```

## 快速开始

### 安装

```bash
uv sync
npm install
```

要求 Node.js 24+。密钥只放在 `.env` 或受控环境变量中，禁止提交到仓库。

### 全量门禁

```bash
npm run check
npm test
npm run schema:check
npm run replay:check       # 冻结 W3 fixture 兼容门禁（非当前策略等价门禁）
uv run pytest tests/ -q
uv run python scripts/gen-status.py --check
```

测试数量不在 README 手工维护；仓库状态由 [`docs/generated/status.md`](docs/generated/status.md) 和 CI 生成结果承载。

### 单租户 TS 入口

```bash
cd packages/arena-agent

npm run arena:doctor -- --config <tenant-config.json>
npm run arena:shadow -- --config <tenant-config.json>
npm run arena:live -- --config <tenant-config.json>
```

运行前必须完成：

1. doctor 只读检查通过；
2. 记录 Python PID、当前 tick、resources、Core 状态和回滚命令；
3. 停止该租户 Python 并确认无第二写者；
4. TS 成功获取单写者锁；
5. 先 3 tick 盯盘，再扩到预定 Canary；
6. SIGTERM 后确认停止提交、flush telemetry、释放锁。

不要直接从 shadow 跳到四租户 hybrid。

## 证据与评估

每次 live 运行至少保留：

```text
runs/<processRunId>/
  manifest.json
  runtime.jsonl
  decision.jsonl
  outcome.jsonl
  pi.jsonl          # 启用 Pi 时
```

可靠性指标优先于收益：

```text
wrong_tick_submit = 0
duplicate_submit = 0
stale_candidate_executed = 0
illegal_final_plan = 0
orphan_process = 0
```

策略收益不能只看 Core 余额变化。主要指标包括：

- `ticks_to_redemption_target`
- `core_resource_gain_per_100_ticks`
- `gross_deposit_per_100_ticks`
- worker idle / travel waste
- upkeep、spawn、heal、repair 支出
- unit loss replacement cost

Replay 用于验证兼容性；真实收益需要交替窗口或高保真模拟器，不能从单段 shadow 日志做反事实结论。

## 文档

- [当前进度与门禁](docs/progress/MASTER.md)
- [TS 迁移计划 W0–W6](docs/migration-plan.md)
- [长期路线 W7–W18](docs/roadmap-long-term.md)
- [Arena Hero v0.11 规则](docs/game-rules.md)
- [目标与资源兑换](docs/GOAL.md)
- [限制与速率分析](docs/LIMITS.md)
- [本地模拟器运行、校准、A/B 与 benchmark](docs/simulator.md)
- [Digital Twin 验收清单](docs/digital-twin-acceptance.md)
- [Digital Twin 历史计划归档](docs/archives/spec-driven-2026-08-03-sim/plan/README.md)

旧的 Python RPC、Debug API 和 handoff 文档属于迁移参考；执行当前任务前先核对 MASTER 和 open issues。

## 当前 Leader issues

- W4 收口与当日指挥：#3
- Pi session 生命周期与 agent-shadow live：#4
- DeterministicPlanner live / Safety A/B：#5
- 仓库 SSOT 整理：#6
- W5 多租户生产运行层：#7

## 长期方向

固定优先级：

```text
正确性
→ 可恢复性
→ 可观测性
→ 确定性算法收益
→ 数据质量
→ 高保真模拟器
→ 价值模型 / Bandit
→ 强化学习
→ 受控自我改进
```

本项目最终不是“让 LLM 直接玩游戏”，而是用确定性安全骨架承载 LLM、优化算法和学习策略，并通过可复现证据逐步提升真实线上决策质量。
