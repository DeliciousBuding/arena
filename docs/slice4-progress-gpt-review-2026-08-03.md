# 切片 4 进度报告（供 GPT 架构审核）

> 状态：进行中（2026-08-03）。审核对象：3E 勘误落地方式 + 切片 4 拆解执行 + leader 集成设计。
> 本文档只写客观事实；待裁决点集中在 §7。

## 1. 仓库状态

- 仓库：`arena` monorepo（npm workspaces），main 分支，`c0060f6`（已 push GitHub，DeliciousBuding/arena）。
- 近 4 个 commit（push 内容）：
  - `20a5a5c` feat(runtime): 3E 接口勘误（runId 单源 + 启动失败立即 Safety + selection deadline 落地）
  - `e631e45` chore(pi-slice4): pin @earendil-works/pi-coding-agent@0.83.0（devDependency）
  - `8fe3153` docs: migration-plan 记录 3E 勘误
  - `c0060f6` feat(pi-slice4): 4C prompt builder + strategy memory（五段决策 prompt + 有界战略记忆）
- 测试数字（`cd packages/arena-agent && npm test`，2026-08-03 实测）：**110 全绿**，0 skip。`npm run check`（tsc --noEmit）0 错误。

## 2. 切片 3（已完成，背景）

W4 决策核心已冻结并验收：

- `DecisionCoordinator`：Safety 预计算 → Lease 注册 → deadline race → PlanArbiter 合成 → expire 先于 abort → 后台 settle；
- `DecisionLease` 状态机（active/accepted/selected/expired/cancelled）+ `LeaseRegistry`（runId 精确索引 + 有界清理 1000）；
- `FakeAgentRuntime`（11 故障模式）+ `FakeClock`（零真实 timer）；
- 零回归门槛：100 tick fixture（burnin-20260802-a）上 coordinator（never-settles）计划 == SafetyPlanner 100/100；
- 16 暗卷全过；完成闸门五项全绿（check/test/schema:check/replay:check/pytest）。

## 3. 3E 接口勘误（2026-08-03，真实 Adapter 前）

三项 P0 已落地（契约修订，leader 维护）：

1. **runId 单源**：`AgentDecisionRequest` 新增 `runId: string`（coordinator 唯一分配）。`startDecision` 返回的 `handle.runId` 必须严格等于 `request.runId`；不一致 → 立即 `handle.abort` + `registry.expire/select` + 立即 Safety + `runtime.reportViolation(reason)`（runtime 标记 unhealthy）。删除了 `setRunIdFor()` 侧通道；Fake runtime 不再自生成 runId，候选 envelope 的 runId 直接取 `request.runId`。
2. **启动失败立即 Safety**：`startDecision` 抛错 → 立即 expire/select Lease + `deadlineOutcome="error"` + SafetyPlan 返回，不再空等 soft deadline（真实故障场景：session 未 ready / 上一 run active / provider 配置缺失 / prompt 同步抛错 / session 损坏）。
3. **selection deadline 真正落地**：候选路径 arbitration + semantic repair 之后取 `selectedAt`；`selectedAt >= selectionDeadline` → 弃候选，用已准备好的 SafetyPlan，`deadlineOutcome="selection_timeout"`（新增值）。`abortSettled` 从 `DecisionResult` 移除——run 最终 settle 改经 `onRunSettled` telemetry 回调上报（不异步修改已返回结果）。

验证：暗卷 17-20 新增（runId 违规立即性 / 启动失败立即性 / selection timeout 弃候选 / settle telemetry），共 20 暗卷 + 零回归全绿（21 测试文件级）。

## 4. 切片 4 拆解与执行状态

按评审拆三份外围并行（agent 各自提交 main，pull --rebase 协作），leader 最后集成：

| 份 | 地界 | 状态 | 备注 |
|----|------|------|------|
| 4A | `src/infrastructure/pi/pi-types.ts` + `pi-session-factory.ts` + 测试 | **进行中** | 会话工厂与依赖闸门；createSession 可注入（测试 spy）；租户隔离 cwd/agentDir；persistent/in-memory session manager |
| 4B | `src/infrastructure/pi/tools/arena-plan.ts` + `arena-map.ts` + `tool-context.ts` + 测试 | **进行中** | 工具参数显式携带 runId/tick/stateHash，ctx 一致性校验；envelope 经 CandidateSink 投递 |
| 4C | `src/infrastructure/pi/prompt-builder.ts` + `strategy-memory.ts` + 测试 | ✅ **已交付**（c0060f6） | 五段 prompt（规则/目标/当前 TickState/短期记忆/工具规则）+ 有界环形记忆（默认 20 条）；9 测试全绿 |
| leader | `pi-agent-runtime.ts` + 集成测试 + 真实 shadow smoke | 未开始（等 4A/4B） | 见 §6 设计 |

### 4C 已交付内容（事实）

- `prompt-builder.ts`：`buildDecisionPrompt({ state, context, runId, memory })` 五段式；规则段含 runId/tick/stateHash 透传句（供 LLM 在 arena_plan 参数中显式回写）+ 六条硬规则（当前 Tick 覆盖旧事实、必须调一次 arena_plan、不写文本计划、不用旧 Tick 数据、无把握提交保守计划、调用后立即结束）。
- `strategy-memory.ts`：有界环形记忆（默认 20 条），`record/snapshot/clear`；snapshot 含目标句、最近 N 条摘要、资源收益累计趋势、safety 兜底占比；deterministic 序列化。
- 已知缺口（agent 报告）：TickState 当前无 `tier`/`phase` 字段，第 3 段按 model.ts 真实字段渲染（未虚构）；PhaseMachine 带状态逻辑，不在纯函数里复刻。

## 5. 已实测的 pi 公共 API 面（0.83.0）

- `createAgentSession(options): Promise<{ session, extensionsResult, modelFallbackMessage? }>`，options 支持 `cwd/agentDir/model/thinkingLevel/noTools("all"|"builtin")/tools[]/excludeTools[]/customTools[]/resourceLoader/sessionManager/settingsManager/modelRuntime`。
- `AgentSession`：`prompt(text, options?): Promise<void>`、`abort(): Promise<void>`、`waitForIdle(): Promise<void>`、`subscribe(listener): () => void`（退订函数）、`getToolDefinition(name)`。
- 事件流（AgentEvent）：`tool_execution_start { toolCallId, toolName, args }`、`turn_start/turn_end { message, toolResults }`、`agent_settled`、`agent_end { messages, willRetry }`。
- `SessionManager.create(cwd, sessionDir?)`（persistent）/ `SessionManager.inMemory(cwd?)`。
- `ModelRuntime.create({ modelNetworkEnabled: false })` 可离线构造（不联网刷新模型目录）。
- `setDefaultStreamFn(fn)`（pi-agent-core 导出）：全局注入 streamFn，签名 `(model, context, options?) => AssistantMessageEventStream`（AsyncIterable，含 start/text_*/thinking_*/toolcall_*/done{reason:"stop"|"toolUse"|"length"}/error）。**零网络集成测试的注入点**。
- `VERSION` 导出（包版本号，用于 run manifest 的 Pi 版本记录）。

## 6. leader 集成设计（PiAgentRuntime，待外围交付后实现）

状态机：`uninitialized → ready → running → aborting → ready`；异常 `running/aborting → unhealthy → rotating → ready`。

- `startDecision(request)`：拒绝重叠 active run → 用 `request.runId`（单源，3E）→ 更新 per-session run 上下文（runId/tick/stateHash/sink）→ `session.prompt(buildDecisionPrompt(...))` → 监听 `agent_settled`/`turn_end` 判定 settle；candidate 只能由 arena_plan 工具 execute 经 sink 产生（工具参数显式携带 runId/tick/stateHash，与 ctx 校验一致才投递）。
- 普通文本完成但未调用 arena_plan → `settled-without-candidate`，coordinator 走 safety（已有路径）。
- `abort(reason)`：同步发 `session.abort()`（不 await）→ 立即返回；settled 后台等 `waitForIdle`。超时未 idle → 标记 unhealthy → rotate session（重建 createAgentSession），rotation 完成前下一 Tick 用 Safety。
- 集成测试配方：`setDefaultStreamFn(fake)` 注入预设事件流（toolUse → done；或 text → done；或 hang 永不 done 测 abort 路径），零网络。

## 7. 待 GPT 裁决的点

1. **工具参数显式携带 runId/tick/stateHash（GPT 4B 规格）的落地方式**：参数由 LLM 生成，实现为「参数必须携带 + execute 与 ctx 一致性校验（不一致 → 拒绝文本，不投递）」。即参数是值来源、ctx 是校验基准。是否接受该双保险，还是要求 ctx 单源？
2. **settle 判定依据**：`prompt()` resolve 与 `agent_settled` 事件的关系（prompt resolve 可能早于事件回调）。拟以事件为准、prompt resolve 兜底，是否有更可靠信号？
3. **TickState 缺 tier/phase**：4C 已按真实字段渲染；是否值得本轮扩 TickState，还是留给切片 5/6？
4. **per-session 单 session 复用 vs 每 run 新 session**：计划长驻单 session（prompt 追加，历史保留），abort 不 settle 才 rotate。与 GPT 切片 4「session rotation」要求是否一致？

## 8. 下一步

- 4A/4B 完成后：验收（测试数/越界/无 skip）→ leader 集成 PiAgentRuntime + 集成测试（零网络）→ 完成闸门全量 → 真实 provider shadow smoke（单租户 100-300 tick）。
