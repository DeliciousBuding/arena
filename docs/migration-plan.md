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

- arena-hero-ts：协议实现、网络生命周期硬化、47 项测试（含 Turn.replace 注入）；
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

- arena `61442e4`：monorepo 合并（TS SDK + 编排层 + 文档清理）；
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

## 4. 合并闸门

- clean clone 可安装；
- SDK、arena-agent、Pi compatibility 测试全绿；
- Golden sequence replay 无未解释语义差异；
- DecisionLease 证明 stale/late plan 永不执行；
- abort 后 session 可复用；
- fault injection 和长时间 soak 无跨 Tick 污染；
- 真机 shadow、单租户和四租户切换通过；
- 停止后无孤儿进程；
- 正式启动路径不再引用 Python。

## 5. 已知风险

- Provider stream 必须响应 AbortSignal；DecisionLease 是必须保留的第二道隔离；
- node:sqlite 同步 API 不能留在主 event loop；
- ~~arena-hero-ts 嵌套 package 需 clean-clone 安装~~（2026-08-02 monorepo 合并后 npm workspace 直接解析，无 pin）；
- raw-state 只能进入 gitignored run 目录，fixture 必须脱敏；
- Pi fork 只保留通用、可上游化修复。
