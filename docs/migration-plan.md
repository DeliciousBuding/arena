# TS 终态迁移：一次性替换 Python 编排层

> 状态：进行中（2026-08-02）。
> 合并策略：一个 Draft PR 内分层开发，只有 TS 端到端替换完成后才合并。
> Python 自此冻结为 raw-state 采集器和差分参考，不再继续演进。

## 1. 最终目标

```text
@arena/arena-agent（每租户一个 Node 进程）
├── arena-hero-ts：权威游戏协议与 Turn API
├── TypeBox contracts：wire / domain / decision
├── TickState reducer + World memory
├── deterministic SafetyPlanner
├── semantic validator + per-action repair
├── Pi createAgentSession（仅 Arena custom tools）
├── DecisionLease + hedged decision + abort
├── MapStore worker
├── telemetry / debug / health
└── supervisor + run manifest
```

职责边界：

- Arena Hero 当前状态是唯一权威事实；
- Pi 负责 Agent loop、模型、会话和战略上下文；
- `arena_plan` 只向当前 DecisionLease 提交候选计划，不直接操作游戏；
- arena-agent 保留最终合法性校验、deadline 裁决和 submit 权；
- Python 不属于目标架构。

## 2. 已完成基线

- arena-hero-ts：协议实现、网络生命周期硬化、48 项测试（含 Turn.replace 注入；数量以 scripts/gen-status.py 实测为准）；
- MapStore TS：WAL、跨进程增量同步、有效 mutation revision（busy_timeout 前置 WAL pragma，并发首开锁修复）；
- W0：AgentSession customTools、abort、waitForIdle、abort 后复用机制已验证；
- W1：TypeBox wire schema 单源 + contracts/generated 契约产物 + Golden Replay（真实 fixture 解析）；
- TS 编排层最小闭环：runtime/loop.ts（reduceTurn → DecisionLease → decide/safety → validatePlan → planToCommandPlan → Turn.replace → submit），21 测试；
- shadow 验证：真实 raw-state（tick 40073-40088）全链路 replay 11/11 通过，只观察不提交（scripts/shadow-run.ts）；
- run-scoped 目录与 manifest；
- Python raw-state dump，仅用于 Golden Replay 素材；
- TS 领域层第一版：规范化 TickState、World、PhaseMachine、导航、SafetyPlanner、PlanValidator、StateHash、DecisionLease。

## 3. 单 PR 实施切片

### C0 — 始终同步最新基线

每次开发前比较：

- `arena/main`（含 TS SDK `packages/arena-hero-ts/`，2026-08-02 起 monorepo 单仓）；
- `pi/arena-llm-bridge`。

发现 Agent 新提交时先同步再继续，避免重复实现。当前基线：

- arena `7387bf7`（main HEAD，2026-08-02）：monorepo 合并（`8ec7f41`）后的最新提交，source 分类修正（GPT R2）；
- pi `da0203a`。

### C1 — 契约与 Golden Replay

TypeBox 单源分三层：

```text
wire      服务端 WS/HTTP 原始协议
domain    arena-agent 规范化状态
decision  LLM 候选计划协议
```

Golden fixture 必须包含 rules/sdk 版本并脱敏；按完整 Tick 序列比较 state、memory、intent 和 plan。

### C2 — 确定性运行核心

完成并验证：

- Turn → immutable TickState；
- World/resource/enemy/unit memory；
- PhaseMachine 与 deterministic nav；
- balance SafetyPlanner；
- semantic validator 与逐动作 repair；
- MapStore 通过 Worker Thread 使用，不能阻塞主 event loop。

`economic/aggressive` 作为 policy 参数和 prompt 变体，不复制 runtime。

### C3 — Pi 原生决策桥

- 只走公开 `createAgentSession()`；
- builtin tools 全禁用，只注册 `arena_map` / `arena_plan`；
- 每 Tick 创建 `DecisionLease(runId, tick, stateHash, deadline)`；
- 立即计算 SafetyPlan，同时启动 Agent；
- soft deadline 前接受合法 Agent 候选，否则 lease 过期、`session.abort()`，提交 SafetyPlan；
- 任何迟到调用均由 DecisionLease 拒绝；
- abort 无法 settle 时才旋转 session。

### C4 — 运行与运维

- append-only 全 Tick JSONL；
- readiness / health / debug API；
- supervisor 管理 4 个独立租户进程；
- process-tree 优雅关闭和孤儿检测；
- manifest 固定 arena、SDK、Pi SHA、schema hash、模型和配置。

### C5 — 切换并删除 Python

切换顺序：

1. TS shadow，只观察和产计划；
2. 单租户 TS deterministic；
3. 单租户 TS + Pi；
4. 四租户 TS；
5. 删除 Python runtime、RPC bridge、重复 parser/schema 和 Python 正式入口。

最终保留的 Python 内容仅限无法替代的离线研究脚本；运行链中不得存在 Python。

## 4. 架构评审切片计划（2026-08-02）

> 2026-08-02 架构评审（GPT）按依赖与风险重新排序的 6 片执行计划，取代原 C0-C5 顺序（原切片内容仍有效，按其重新归组）。评审全文由管理者另行落档：`docs/archives/history-2026-08-03/architecture-review-gpt-2026-08-02.md`（原文存档）。本表为摘要级切片。

### 切片 1 — 可复现构建和 CI（2-3 天）

- 目标：消除 R1（测试数 / commit SHA 手工维护漂移），仓库状态可自动复现。
- 关键内容：`scripts/gen-status.py` 生成权威 `docs/generated/status.md`（本切片已落地）；CI 接入 SDK / 编排层测试与 contracts 契约零漂移检查（原待裁决问题 6「TS 无 CI」）。
- 验收变化：测试数与 commit SHA 单一权威来源；CI 全绿，不再有手工维护数字。

### 切片 2 — W3 Sequence Differential Replay（3-4 天）

- 目标：同一 raw-state fixture 分别走 Python 决策链与 TS 决策链，逐 Tick 差分对比，消灭未解释语义差异。
- 关键内容：离线回放框架（现有 scripts/shadow-run.ts 为 TS 单侧）；Python 侧回放；按 state / memory / intent / plan 四维比较，差异分类并修复。
- 验收变化：差分报告零未解释差异；Golden Replay 纳入 CI，禁止回归。

> ✅ **已完成（2026-08-03）**：契约 v1.0.1 + 机器 Schema（contracts/differential/）+ fixture
> burnin-20260802-a（100 tick 连续 segment，manifest 驱动，config 单源注入）+
> E1/E2 回放器（scripts/replay_py.py / packages/arena-agent/scripts/replay-ts.ts）+
> E3 差分比较器（scripts/diff_replay.py + 有界白名单）。W3 关单时实测 100 tick：
> **STATE_CLEAN · 未解释差异 0 条 · plan 内容差异 0/100**。此后 Python 策略层冻结，
> TS planner 经真机验证继续演进；冻结 fixture 中随之出现的单位 MOVE 参数差异只在
> `burnin-20260802-a / unknown / unknown-001 / 40437–40536` 范围内豁免。该豁免不覆盖
> state/metadata、动作类型、缺动作、Core 动作或其他 record key。当前策略由单测、
> Digital Twin 与 live burn-in 门禁负责，W3 不再作为“复刻退役 Python 策略”的门禁。

### 切片 3 — W4 决策核心，不接真实 Provider（4-5 天）

- 目标：决策核心（DecisionLease + hedged decision + abort）用 mock provider 完整实现并验证，不依赖 pi。
- 关键内容：`DecisionLease(runId, tick, stateHash, deadline)` 三重校验；soft deadline 前接受合法候选，否则 lease 过期 + `session.abort()` 提交 SafetyPlan；迟到调用一律拒绝；abort 后会话复用。
- 验收变化：stale / late plan 永不执行（fault injection 测试证明）；abort / 复用闭环测试全绿。

> ✅ **已完成（2026-08-03）**：契约冻结（decision-types.ts）+ 3A Clock/DeadlineBudget +
> 3B LeaseRegistry（runId 精确索引 + 状态机 + 有界清理）+ 3C AgentRuntime 端口 + Fake
> （11 故障模式走 sink 路径）+ 3D PlanArbiter（Hybrid 合成 + emergency）+ leader 集成
> DecisionCoordinator（Safety 预计算 → deadline race → expire 先于 abort → 后台 settle）。
> 16 暗卷全过；零回归门槛：100 tick fixture 上 coordinator（never-settles）计划 ==
> SafetyPlanner 100/100。完成闸门五项全绿（check/test/schema:check/replay:check/pytest）。
>
> 3E 勘误（2026-08-03，真实 Adapter 前）：`AgentDecisionRequest` 显式携带 runId（coordinator
> 唯一分配，handle 不一致 → 立即 Safety + reportViolation）；startDecision 抛错立即返回
> （deadlineOutcome=error，不等 soft deadline）；selection deadline 落地（arbitration+repair
> 后取 selectedAt，超限弃候选 → selection_timeout）；abortSettled 移除，settle 经 onRunSettled
> telemetry 上报。暗卷 17-20 补齐（共 20 暗卷 + 零回归全绿）。
> 下一步：切片 4 真实 Pi Adapter（消灭 Python RPC 桥）。

### 切片 4 — 真实 Pi Adapter（4-5 天）

- 目标：决策核心接真实 pi `createAgentSession`，消灭 Python RPC 桥。
- 关键内容：仅注册 `arena_map` / `arena_plan` 两个 custom tools，builtin 全禁用；每 Tick 决策桥接线，模型经 pi 框架（deepseek-v4-flash）调用；先在 shadow 模式只观察不提交。
- 验收变化：真实 LLM 逐 Tick 决策在 shadow 下稳定运行；Python RPC 桥从决策链移除。

> ✅ **验收通过（2026-08-04）**：真实 LLM（deepseek-v4-flash via pi `createAgentSession`）在
> t1 shadow 下连续 30 Tick：**27 candidate / 2 soft_deadline / 1 error**（前 3 tick 冷启动，
> 第 4 tick 起连续 27 tick 全稳定）；LLM 产生 **216 个有效动作、0 invalid**（parse/validate
> 全过），SafetyPlanner 兜底替换 27 次；0 rotation / 0 prompt_error；warmup 成功。延迟
> 稳定期 4.4-5.9s ≪ agentSoft 14s。同期补全 CLI `--shadow` 选项（文档承诺、代码缺失）。
> Python RPC 桥已不在 TS 决策链（`NoopAgentRuntime` 仅 safety/deterministic 用）。

### 切片 5 — 运行与运维层（4-5 天）

- 目标：补齐原 W5 supervisor 与运维闭环（对应 Python debug API / 看门狗 / 遥测的 TS 对应物）。
- 关键内容：supervisor 管理 4 个租户进程；append-only 全 Tick JSONL；readiness / health / debug API；process-tree 优雅关闭与孤儿检测；run manifest 固定 arena / SDK / Pi SHA、schema hash、模型与配置；MapStore 走 worker 线程，node:sqlite 不阻塞主 event loop。
- 验收变化：四租户并行稳定运行；停止后无孤儿进程；遥测 / 调试端点可用；manifest 可复现运行环境。

> ✅ **已完成（2026-08-04，切片 6 前置）**：`TenantSupervisor`（4 租户进程管家：spawn /
> SIGTERM 优雅关闭 / SIGKILL 超时兜底 / supervisor.jsonl 事件流）+ `DebugServer`
> （只读 /health /state /events /tenants）+ `run-supervisor` CLI（--live/--mode/--port
> 透传）。单元测试 7 个（fake-child 零真实进程）。MapStore worker 化延后：MapStore 不在
> 主决策链（仅 pi 工具经 map-snapshot 使用），非切换 blocker。其余遥测/manifest 已有
> （runtime/decision/pi/outcome.jsonl + run manifest）。

### 切片 6 — 真机切换与 Python 删除（5-7 天）

- 目标：按序切换真机，删除 Python 运行时。
- 关键内容：切换顺序 TS shadow → 单租户 TS deterministic → 单租户 TS + Pi → 四租户 TS；删除 Python runtime、RPC bridge、重复 parser/schema 与正式入口，仅保留无法替代的离线研究脚本。
- 验收变化：运行链零 Python；正式启动路径不再引用 Python；每步切换有回退预案。

> ✅ **进行中（2026-08-04）**：
> 1. TS shadow 验收已过（切片 4，27/30 candidate）；
> 2. 单租户 TS deterministic live 验证中（t1，100 tick 真机提交，全部 accepted）；
> 3. **Python 运行链已删除**：`src/arena_bot/` 全部、`scripts/{replay_py,pi_rpc_bridge,
>    compare_legacy,debug_decide}.py`、`tests/`（Python 测试）随运行链退役；
>    gen-status/CI/package.json 引用同步清理（py job = docs/status drift gate 仅；
>    replay:python/diff/check 移除）；保留 scripts/diagnose.py 等独立离线工具。
> 4. 待做：单租户 TS + Pi（agent live）、四租户 TS 并行、最终验收记录。

## 5. 合并闸门

- clean clone 可安装；
- SDK、arena-agent、Pi compatibility 测试全绿；
- Golden sequence replay 无未解释语义差异；
- DecisionLease 证明 stale/late plan 永不执行；
- abort 后 session 可复用；
- fault injection 和长时间 soak 无跨 Tick 污染；
- 真机 shadow、单租户和四租户切换通过；
- 停止后无孤儿进程；
- 正式启动路径不再引用 Python。

## 6. 已知风险

- Provider stream 必须响应 AbortSignal；DecisionLease 是必须保留的第二道隔离；
- node:sqlite 同步 API 不能留在主 event loop；
- ~~arena-hero-ts 嵌套 package 需 clean-clone 安装~~（2026-08-02 monorepo 合并后 npm workspace 直接解析，无 pin）；
- raw-state 只能进入 gitignored run 目录，fixture 必须脱敏；
- Pi fork 只保留通用、可上游化修复。

## 7. 长期路线图（W7-W18）

> W6 不是终点。迁移完成后的长期规划（生产运行系统 / Planner 竞赛 / 数据平台 / 模拟器 / Bandit / 价值模型 / RL / 自我改进 / 协同智能 / 通用化）见 [roadmap-long-term.md](roadmap-long-term.md)。Leader 长期优先级固定：正确性 → 可恢复性 → 可观测性 → 确定性算法收益 → 数据质量 → 模拟器真实性 → ML → RL → 自我改进 → 平台化。
