# Arena Hero 机器人项目架构评审与优化设计（GPT 评审原文存档）

> **来源**：2026-08-02 外部架构评审（ChatGPT，输入为 `docs/prompt-gpt-architecture-review.md`）。
> **性质**：权威输入存档，不改动原文；执行决策与状态见 `docs/migration-plan.md` 切片计划。
> **核心结论**：现有方向基本正确，无须推倒重来；真正的系统风险集中在 W4 实时决策桥、运行时工程化和切换过程，而不是领域策略本身。

---

# Arena Hero 机器人项目架构评审与优化设计

> 评审基线：2026-08-02 当前 monorepo 主线。
> 核心结论：**现有方向基本正确，无须推倒重来；真正的系统风险集中在 W4 实时决策桥、运行时工程化和切换过程，而不是领域策略本身。**

当前项目已经建立了合理的三层边界：SDK 负责 wire 协议，`arena-agent` 负责权威状态和执行裁决，Pi 负责 Agent loop 与会话。W0、W1、W2 已经完成，真正尚未闭环的是 W4、Supervisor 和 Python 退役。

推荐的最终形态不是"Pi 控制 Arena"，而是：

```text
Pi 产生候选决策
        ↓
arena-agent 校验、裁决、限时、回退
        ↓
arena-hero-ts 提交权威 CommandPlan
```

Pi 永远不应持有游戏提交权。

---

## 一、架构评审

## 1. 最值得警惕的五个风险

### 风险一：当前主循环并没有实现真正的 hedged decision

当前 `handleTurn()` 的实际顺序是：

```text
await Agent decide
→ Agent 返回/报错后
→ 才计算 SafetyPlanner
```

并不是：

```text
SafetyPlan 立即完成
与 Agent 并行运行
→ 截止时二选一
```

同时，`deadlineMs` 目前只是写入 `DecisionLease.deadlineAt`，并没有用定时器中断 `options.decide()`。如果 Agent Promise 永远不返回，整个租户 Tick 循环也会永久挂住。

**失效场景：**

* Provider 流长时间无 token；
* Pi session 未 settle；
* 工具调用停在半途；
* 网络连接既不成功也不报错；
* Agent 在第 14 秒返回候选，随后验证和 HTTP submit 越过 15 秒窗口。

`DecisionLease` 只能拒绝"已经到达的迟到候选"，不能主动让挂起任务返回，也不能保证最终提交仍在窗口内。

**裁决：W4 必须先重构决策时序，再接真实 Pi。**

---

### 风险二：截止时间目前只有一个概念，缺少完整预算模型

实时系统至少需要三个不同截止时间：

```text
Agent soft deadline
最终计划 selection deadline
HTTP submit reserve / hard deadline
```

不能只用一个 `deadlineAt`。

当前 Lease 使用 `Date.now()` 判断时间。这存在两个问题：

1. 系统时钟可能因同步而跳变；
2. Lease 只约束候选到达时间，不约束验证、repair、序列化和提交完成时间。

**失效场景：**

* Agent 在 deadline 前 5ms 到达，被接受；
* validator 和 MapStore 查询消耗数百毫秒；
* HTTP 第一次提交超时，SDK 开始重试；
* 服务端返回 `TICK_MISMATCH`。

**建议：**

使用单调时钟，并从 Tick 到达时建立完整预算：

```text
T0       收到 Turn
Tsoft    停止等待 Agent
Tselect  最终计划必须确定
Tsubmit  必须开始/完成提交
Thard    游戏窗口结束
```

Agent abort 不应阻塞 SafetyPlan 提交。

---

### 风险三：直接运行 TypeScript 源码、不构建、无 TS CI，不适合作为最终运行态

目前 TS 测试依赖 `tsx` 和 Node 的实验性类型转换能力，生产也直接加载 TS 源码；根 package 尚没有统一 build/test/check 脚本。

这在迁移阶段可以接受，但不能成为正式部署方式。

**失效场景：**

* 本地 Node 24 可运行，服务器 Node 22 行为不同；
* node_modules 中 TS 的处理方式变化；
* `node:sqlite` 在不同 Node 小版本行为不同；
* 某个包的类型错误没有进入测试路径；
* schema 生成结果被修改但未重新生成；
* 开发者本机测试绿，clean clone 无法运行。

**裁决：CI 和生产构建必须在 W4 前完成，不应排到最后。**

正式运行应是：

```text
src/*.ts
  ↓ tsc/esbuild
dist/*.js + *.d.ts
  ↓
node dist/...
```

测试仍可使用 `tsx`，但生产不得依赖 TS loader。

---

### 风险四：长 Pi 会话可能把"战略记忆"变成"过期状态污染"

原则上已经明确：当前 Tick 是唯一权威事实，记忆只是线索。这一点是正确的。但 Pi session 默认会累积：

* 每 Tick 的状态 prompt；
* 过去的计划；
* 工具调用；
* 失败信息；
* compaction 结果。

如果不专门设计上下文，模型可能根据旧 Tick 的单位、资源或敌人位置做决策。

**失效场景：**

* 上一 Tick 某单位存在，本 Tick 已死亡；
* compaction 摘要仍描述该单位的任务；
* Agent 使用摘要中的旧 UUID；
* validator 删除该动作，最终部分单位无动作；
* 系统表现为"合法但持续低效"。

**建议：**

将上下文分成四层：

1. 稳定规则和工具政策；
2. 战略摘要；
3. 当前权威 Tick；
4. 最近少量执行结果。

当前 Tick 必须完整覆盖旧观察；战略记忆不得保存单位当前 HP、位置、cargo 等瞬时事实。

---

### 风险五：一次性替换不等于一个巨大、不可审查的 PR

"Python 不长期双轨"是正确的，但"所有 W3–W6 都堆进一个巨大 PR"会产生新的工程风险。

**失效场景：**

* PR 同时修改 SDK、Agent、Supervisor、遥测和删除 Python；
* 一处回归难以定位到具体架构切片；
* review diff 数千至上万行；
* 真机验证期间主线继续前进；
* 最终只能整体合并或整体放弃。

**建议：**

使用：

```text
ts-replacement 集成分支
├── stacked PR 1：CI / build / contracts
├── stacked PR 2：W3 replay
├── stacked PR 3：W4 runtime
├── stacked PR 4：Supervisor / control plane
└── final cutover PR：切换入口 + 删除 Python
```

这样仍是"一次性切换"，但不是"一次性审查所有代码"。

---

## 2. 被低估的三个设计亮点

### 亮点一：DecisionLease 是非常正确的安全边界

`DecisionLease` 把 Agent 的能力限制成：

> 对某个 Tick、某个 state hash、某段时间内，提交一次候选计划的权利。

它检查协议版本、Tick、状态 hash、plan Tick 和 deadline，并且只接受一次。

这比通过消息队列"猜哪个工具调用属于哪个 Tick"可靠得多。

它应继续保留，即使未来 Pi 的 abort 和事件关联已经完全可靠。Pi 层取消是第一道防线，Lease 是第二道防线。

---

### 亮点二：wire、domain、decision 三种模型正在正确分离

这三个模型本来就不应该是同一个结构：

* wire：服务端真实协议；
* domain：适合策略消费的规范化状态；
* decision：Agent 可生成的受限候选计划。

这能避免游戏 SDK 的实现细节渗透到策略层，也避免 LLM 工具 schema 变成完整服务端协议的镜像。

结合 TypeBox 单源和 Golden Replay，这为协议演进、离线测试和 Python 删除提供了较强基础。

---

### 亮点三：最终提交权保留在确定性编排层

当前设计没有让模型直接调用 SDK，而是：

```text
Agent candidate
→ Lease
→ semantic validation
→ repair
→ wire conversion
→ Turn.replace
→ submit
```

这使得 LLM 可以被替换、禁用、超时或失败，而游戏运行时仍然存在。

这是整个架构最重要的正确选择。SafetyPlanner 不是普通 fallback，而是系统的实时安全基础设施。

---

# 二、W4 决策桥设计

## 1. 推荐形态

推荐继续采用：

> **TS 编排层嵌入 Pi 的公开 `createAgentSession()`，但必须通过内部 Port/Adapter 隔离。**

"嵌入 Pi"本身不违反依赖倒置。违反依赖倒置的是让领域层直接到处 import Pi 类型。

推荐边界：

```text
domain/
  不认识 Pi、HTTP、SQLite、WebSocket

application/
  DecisionCoordinator
  AgentDecisionRuntime interface
  PlanArbiter
  DeadlineBudget

infrastructure/pi/
  PiAgentRuntime implements AgentDecisionRuntime
  Pi tool definitions
  session persistence
  context builder
```

概念接口：

```text
AgentDecisionRuntime
├── start()
├── decide(request, signal)
├── abort(runId)
├── waitForIdle(timeout)
├── rotate(reason)
├── health()
└── close()
```

`DecisionCoordinator` 依赖接口，不依赖 `createAgentSession()`。

Pi 作为实现细节提供：

* Agent loop；
* provider；
* tool calling；
* session；
* compaction；
* token/cache 管理。

不建议"Pi 只做模型提供"，因为那会迫使 Arena 重写一次 Agent loop、工具调用和会话管理，失去使用 Pi 的意义。

---

## 2. 组件划分

```text
TenantRuntime
│
├── GameClient
├── StateReducer
├── WorldReducer
├── SafetyPlanner
├── DecisionCoordinator
│   ├── DeadlineBudget
│   ├── DecisionLeaseRegistry
│   ├── AgentDecisionRuntime
│   ├── PlanValidator
│   └── PlanArbiter
├── MapSnapshotProvider
├── TelemetrySink
└── Submitter
```

### DecisionCoordinator

它是 W4 核心，负责：

* 每 Tick 创建唯一 DecisionRun；
* 创建 Lease；
* 立即生成 SafetyPlan；
* 启动 Agent；
* 执行 deadline race；
* 选择 Agent、Hybrid 或 Safety；
* 触发 abort；
* 验证和提交；
* 记录完整事件。

### PiAgentRuntime

它负责：

* 每租户一个长驻 AgentSession；
* custom tools 注册；
* session persistence；
* prompt/context；
* abort、settle 和 session rotation；
* provider 错误分类。

它不负责：

* 游戏 deadline；
* Plan 最终合法性；
* submit；
* SafetyPlan；
* 决定哪个候选胜出。

### LeaseRegistry

`arena_plan` 不应直接捕获"当前全局 Lease"而没有运行标识。

推荐工具参数至少包含：

```text
runId
tick
stateHash
plan
reason
confidence
```

工具调用通过：

```text
LeaseRegistry.submit(runId, candidate)
```

查找精确 Lease。

否则旧 Agent run 的迟到工具调用，理论上可能误投递到新的"当前 Lease"。

---

## 3. 每 Tick 生命周期

```text
Turn 到达
  │
  ├── reduceTurn → immutable TickState
  ├── 固化 DecisionContext
  │     ├── stateHash
  │     ├── mapRevision
  │     ├── rulesVersion
  │     ├── schemaVersion
  │     └── configVersion
  │
  ├── 创建 DecisionLease
  ├── 立即计算并验证 SafetyPlan
  └── 并行启动 Pi Agent run
```

随后：

```text
Agent 在 soft deadline 前提交候选
  ├── Lease 接受
  ├── semantic validation
  ├── repair / safety completion
  └── 选择 Agent 或 Hybrid

Agent 未及时提交
  ├── 先 expire Lease
  ├── 立即选择 SafetyPlan
  ├── 异步 session.abort()
  └── 不等待 abort 完成即可进入 submit
```

关键顺序必须是：

```text
expire Lease
→ 固定最终计划
→ submit
→ 清理 Agent
```

而不是：

```text
等待 abort 完成
→ 再 submit
```

---

## 4. Deadline 预算

推荐从 15 秒窗口中明确划分：

```text
0 ms       收到 Turn
0–100 ms   reducer / world snapshot / SafetyPlan
100 ms     启动 Agent
~8–10 s    Agent soft deadline
~10–11 s   最终校验与计划固定
余下时间   HTTP submit、重试和网络抖动
15 s       游戏 hard deadline
```

具体数值应通过 telemetry 调整，而不是固定写死。

预算对象应包含：

```text
receivedAtMonotonic
agentSoftDeadline
selectionDeadline
submitDeadline
gameHardDeadline
```

使用单调时钟，不使用墙上时间做 elapsed 判断。

---

## 5. Agent、Hybrid 和 Safety 的选择

不建议把"逐动作 repair"简单实现成"删除所有非法动作"。

更稳妥的是：

```text
Agent 中合法的单位动作
+
SafetyPlan 为缺失或非法单位提供的动作
=
HybridPlan
```

优先级：

```text
合法 Agent action
> 对应单位的 Safety action
> WAIT
```

Core 同理。

最终来源应细分为：

* `agent`
* `hybrid`
* `safety`
* `manual`
* `replay`

如果 Agent 计划被修复比例过高，例如大多数动作非法，则直接采用完整 SafetyPlan，而不是伪装成 Agent 成功。

---

## 6. Agent session 生命周期

### 启动

每租户创建独立：

* session directory；
* AgentSession；
* model/provider 配置；
* tool registry；
* 战略记忆。

Arena 的 readiness 不应依赖 LLM 正常。

建议健康状态分开：

```text
game_ready = true
safety_ready = true
agent_ready = false
overall_mode = deterministic_degraded
```

这样 Provider 故障不会导致机器人完全退出。

### 正常运行

严格保证：

> 每租户、每个 AgentSession 同时最多一个 active run。

下一 Tick 到来时，如果旧 run 仍未 settle：

1. 不允许启动第二个 prompt；
2. 等待极短 settle grace；
3. 仍未 idle 则旋转 session；
4. 本 Tick 使用 SafetyPlan。

### Session rotation 条件

* abort 后无法 settle；
* provider stream 不响应 AbortSignal；
* 连续多次工具协议错误；
* 上下文达到阈值；
* compaction 失败；
* 模型/provider/rules/schema 变更；
* session 文件损坏；
* 显著异常的延迟或 token 增长。

---

## 7. Pi 资源加载和权限隔离

虽然 builtin tools 已禁用，但仍应注意 Pi 默认可能加载：

* 项目 AGENTS 文件；
* skills；
* extensions；
* prompt templates；
* cwd 相关上下文。

游戏 Agent 不应把整个代码仓库当作运行上下文。

推荐：

* 独立、最小化 `cwd`；
* 独立 `agentDir`；
* 显式 ResourceLoader；
* 只加载 Arena system rules；
* 只启用 `arena_map` 和 `arena_plan`；
* 禁止 shell、read、write、网络任意 URL；
* 每租户独立 session 文件。

---

## 8. Hedged decision 的含义

生产默认推荐：

```text
一个 LLM Agent
+
一个确定性 SafetyPlanner
```

不推荐每 Tick 同时跑两个 LLM。

双 LLM 会带来：

* 双倍成本；
* provider 限流；
* 更复杂的胜者选择；
* 更难复现；
* 四租户同步请求造成更强流量尖峰。

第二模型更适合作为：

* 离线 challenger；
* shadow 评测；
* 特定故障下的备用 provider；

而不是常规 Tick 的第二条关键路径。

---

# 三、十个待裁决问题的结论

| # | 问题 | 裁决 | 理由 |
| -- | ------------------- | -------------------------------------------------------------------- | ----------------------------------------------- |
| 1 | Python raw-state 污染 | **立即按 `run/tenant/tick` 分目录，并使用临时文件后原子 rename** | 数据损坏会直接让 W3 失去意义；这是数据正确性修复，不是继续演进 Python |
| 2 | LLM 决策桥形态 | **嵌入 `createAgentSession()`，但放在 `PiAgentRuntime` Adapter 中** | 保留 Pi 的 Agent 能力，同时让 Arena 控制生命周期、deadline 和提交权 |
| 3 | 确定性与 LLM 可复现 | **不追求 LLM 位级确定性，采用事件溯源和 recorded-candidate replay** | seed 不能保证跨 provider、版本和并发的完全复现 |
| 4 | MapStore | **永久事实共享，动态事实留在租户 World；SQLite 放 Worker Thread** | 共享障碍有价值，但同步 SQLite 不应阻塞主事件循环 |
| 5 | 多租户模型 | **维持 4 个独立 Node 进程** | 凭据、崩溃、内存、session 和 event loop 都需要故障隔离 |
| 6 | TS CI | **现在立即补，且应早于 W4** | 没有 CI 的实时运行时不应继续扩大代码规模 |
| 7 | contracts 单源归属 | **wire 归 SDK；decision/map-query 归独立 contracts package；pi-arena 只消费** | Adapter 不应成为领域协议的所有者 |
| 8 | 外部控制面 | **Supervisor 暴露聚合控制面，租户只暴露内部 health/status** | 避免端口散落和控制 API 绕过正常决策链 |
| 9 | Pi fork | **仅保留通用 custom-tool 类型/API 修复，能上游就上游；零 Arena 命名和业务逻辑** | 当前 fork 差异规模很小，应避免永久维护私有分叉 |
| 10 | 追上游 | **自动生成契约差异报告，但语义升级需人工批准** | 自动发现变化，不能自动猜测游戏规则含义 |

---

## 问题 3 的具体复现策略

对 LLM 运行记录：

```text
state canonical JSON + stateHash
world snapshot revision
rules/schema/prompt versions
model/provider/version
session id + generation
effective context hash
tool input
candidate plan
timings
token/cache usage
abort result
final selected plan
```

提供三种 replay：

1. **Deterministic replay**：只重跑 reducer、World、SafetyPlanner、validator。
2. **Recorded candidate replay**：使用历史 Agent candidate，验证 Lease、repair 和最终选择。
3. **Live model reevaluation**：重新请求模型，用于评测，不要求输出相同。

---

## 问题 4 的 MapStore 形态

推荐：

```text
Tenant main event loop
├── 当前 Tick immutable DecisionContext
├── 本地只读 MapSnapshot
└── MapStoreWorker
      └── node:sqlite WAL
```

主线程不应每次决策同步等待 SQLite。

Worker 负责：

* 批量写新障碍；
* 增量读取 revision；
* 刷新 snapshot；
* 处理 busy retry。

主线程使用最近成功的 snapshot。MapStore 暂时不可用时，使用当前 Tick 的可见障碍，不阻塞决策。

共享范围：

| 数据 | 是否共享 |
| ---------- | ---------------------------------- |
| 障碍 | 是，永久 |
| 我方用户名/Core | 是，长期 |
| 资源 | 默认否；未来可 TTL 共享 |
| 敌人位置 | 默认否；如共享必须短 TTL、observer、confidence |
| 战略假设 | 否 |

---

## 问题 8 的控制面

建议 Supervisor 提供一个统一控制端点：

```text
/status
/health
/tenants
/metrics
/commands/pause
/commands/resume
/commands/rotate-session
/commands/restart-tenant
/commands/shutdown
```

租户进程通过 IPC 或仅 loopback 的随机/分配端口提供内部状态。

所有命令必须：

* 带 tenant ID；
* 有 command ID；
* 幂等；
* 在 Tick 边界应用；
* 写入 telemetry；
* 不能直接修改当前 `TickState`。

手动计划注入如需保留，也必须经过：

```text
DecisionLease
→ validator
→ arbiter
→ submit
```

不能绕开编排层。

Watchdog 应监控：

* WS 最后事件时间；
* 最后处理 Tick；
* 最后成功 submit；
* Agent run 是否卡住；
* fallback 比例；
* TICK_MISMATCH 比例；
* 进程 event-loop lag；
* 资源/单位是否长期无进展；
* 磁盘、JSONL 和 session 目录增长。

---

# 四、未来 2–4 周实施排序

## 切片一：可复现构建和 CI

**时间：2–3 天**

内容：

* 固定 Node 精确版本；
* 增加根级 `build/check/test/schema:check`；
* 生产构建输出 `dist/`；
* clean-clone `npm ci`；
* TS SDK、arena-agent、schema zero-diff 接入 CI；
* Python 基线在删除前继续跑；
* 修复 raw-state 按租户隔离和原子写；
* 测试统计由脚本生成，不再手写。

验收：

```text
fresh clone
→ npm ci
→ npm run build
→ npm test
→ npm run schema:check
```

全部通过。

**可验证变化：** 任意机器可构建和运行相同产物；本地环境不再是隐形依赖。

---

## 切片二：W3 Sequence Differential Replay

**时间：3–4 天**

内容：

* 选择多租户、连续 Tick fixture；
* 脱敏；
* 比较 Python 与 TS：
  * normalized state；
  * World memory；
  * unit memory；
  * phase；
  * intent；
  * final SafetyPlan；
* 明确允许差异白名单；
* 生成机器可读 diff 报告。

验收：

* 至少覆盖资源出现/消失；
* 采集成功和失败；
* 单位生成/死亡；
* Core 非 NORMAL；
* 敌人出现/消失；
* Beacon；
* 跨 Tick Worker 目标；
* 共享地图 revision 变化。

**可验证变化：** 确认 TS 确定性核心可以替代 Python，而不是只通过少量单 Tick fixture。

完成后 Python 策略层正式冻结，不再参与新功能。

---

## 切片三：W4 决策核心，不接真实 Provider

**时间：4–5 天**

内容：

* `AgentDecisionRuntime` port；
* `DecisionCoordinator`；
* 单调 deadline budget；
* SafetyPlan 并行预计算；
* DecisionLeaseRegistry；
* Hybrid Plan 合成；
* fake Agent runtime；
* virtual clock/fake timer 测试；
* circuit breaker；
* abort 后台清理；
* 同 session 单 active run。

故障测试：

* Agent 永不返回；
* deadline 前后边界；
* 旧 run 迟到 tool call；
* 错误 runId/tick/stateHash；
* 重复工具调用；
* abort 不 settle；
* validator 删除部分动作；
* submit 慢或报错。

验收：

> 无论 Fake Agent 如何挂起，系统都必须在 selection deadline 前固定 Safety 或 Hybrid 计划。

**可验证变化：** 实时安全模型已经成立，Pi 只是可插拔决策者。

---

## 切片四：真实 Pi Adapter

**时间：4–5 天**

内容：

* 只用公开 `createAgentSession()`；
* 独立 cwd/agentDir；
* custom tools only；
* `arena_plan` 接 LeaseRegistry；
* `arena_map` 使用注入的 MapSnapshotProvider；
* 稳定规则与当前 Tick context；
* session persistence；
* abort/waitForIdle；
* session rotation；
* context/compaction 策略；
* provider/token/cache telemetry。

验收：

* prompt → plan → submit candidate；
* soft timeout → SafetyPlan；
* abort 后 session 可复用；
* abort 不 settle → rotate；
* 旧工具调用无法命中新 Lease；
* Provider 不可用时进入 deterministic degraded mode。

**可验证变化：** W4 完整闭环，Python RPC 桥不再承担 LLM 决策。

---

## 切片五：运行与运维层

**时间：4–5 天**

内容：

* MapStore Worker Thread；
* append-only event telemetry；
* 聚合 Supervisor；
* readiness/health；
* 控制命令；
* account lock；
* process-tree shutdown；
* restart/backoff；
* run manifest；
* event-loop lag；
* 磁盘和 session 配额。

验收：

* 四个本地模拟租户可启动；
* 单租户崩溃不影响其他租户；
* 旧进程未退出时禁止同账号重复启动；
* 全部停止后无 Node 孤儿；
* SQLite busy 不阻塞 Tick deadline；
* LLM 故障不使 game loop 退出。

**可验证变化：** 系统从"能运行的 Agent"变成可监督、可恢复的多租户服务。

---

## 切片六：真机切换与 Python 删除

**时间：5–7 天**

顺序：

1. TS shadow；
2. 单租户 TS deterministic；
3. 单租户 TS + Pi；
4. 两租户；
5. 四租户；
6. 模拟数千 Tick fault/soak；
7. 真机持续运行；
8. 删除 Python runtime。

切换指标建议：

* deadline miss；
* TICK_MISMATCH；
* Safety fallback rate；
* Agent valid rate；
* Hybrid rate；
* repair rate；
* submit latency；
* session rotation；
* event-loop lag；
* 每 Tick token/cost；
* 资源获取效率。

最终删除：

* Python 主循环；
* Pi RPC bridge；
* Python supervisor；
* Python debug/watchdog/telemetry；
* 重复 schema/parser；
* uv 正式运行入口。

可保留：

* 上游 Python SDK reference；
* 必要的离线协议对比脚本；
* 脱敏 Golden fixtures。

**可验证变化：** 正式启动和运行链中不存在 Python。

---

# 五、额外风险登记

## R1：文档和测试数字已经出现漂移

评审 Prompt 写 SDK 48 项测试，而 `migration-plan.md` 仍写 47 项。

这说明测试数、完成度和 commit SHA 不应手工维护在多个文档中。

建议由脚本生成：

```text
docs/generated/status.md
```

其中包含：

* commit SHA；
* 测试数量；
* schema hash；
* Python 待删除模块数；
* 最近 CI 状态。

---

## R2：当前 source telemetry 可能误分类

现有 loop 中，只要 validator 修改了计划，就把 source 设为 `repaired-agent`，即使原计划来自 SafetyPlanner。

建议拆分：

```text
original_source
final_source
repair_count
replacement_count
```

例如：

```text
original_source=safety
final_source=safety
repair_count=1
```

而不是伪装成 repaired-agent。

> ✅ 已执行（2026-08-02 commit 7387bf7）：TickOutcome 加 originalSource + repairCount，repair 只提升 agent 来源。

---

## R3：state hash 不足以完整描述决策上下文

同一 TickState 在以下变化后仍可能产生不同决策：

* MapStore revision；
* 规则版本；
* 策略配置；
* prompt 版本；
* schema 版本；
* 战略记忆；
* 模型配置。

Lease 仍应以当前权威 state hash 为核心，但 telemetry 应额外记录：

```text
decisionContextHash
```

它可以包含这些非权威但影响决策的版本信息。

---

## R4：四租户会产生同步 Provider 流量尖峰

四个账号 Tick 时间接近，会同时启动四次模型请求。

可能造成：

* provider 429；
* NewAPI 队列；
* 首 token 延迟同步升高；
* 四租户同时 fallback。

建议：

* 记录全局 provider concurrency；
* 允许 Supervisor 提供跨进程 admission budget；
* 限流时优先 Safety，而不是排队到窗口末端；
* 不要用随机长延迟错峰，因为窗口只有 15 秒。

---

## R5：离线 shadow 不能替代真机 shadow

离线 replay 无法覆盖：

* WebSocket 断线重连；
* 真实 Tick deadline；
* SQLite 多进程竞争；
* Provider 延迟；
* HTTP submit；
* 进程退出；
* 磁盘压力。

11/11 离线通过只能证明纯逻辑闭环，不能证明运行时可靠。

---

## R6：长期存储会无限增长

需要为以下目录建立配额和轮换：

* raw-state；
* JSONL telemetry；
* Pi sessions；
* debug logs；
* provider traces；
* Golden candidate 数据。

raw-state 不应默认永久开启。迁移结束后应：

* 关闭全量原始状态；
* 仅保留采样或错误窗口；
* 压缩归档；
* 设置最大大小/最大天数。

---

## R7：进程重启可能造成同账号双客户端

Supervisor 启动新租户前必须确保旧进程已完全退出。

建议每账号使用：

* OS lock/file lock；
* 唯一 tenant instance ID；
* 进程组；
* 启动 generation；
* health handshake。

否则旧进程残留时，新旧进程可能同时连接和提交。

---

## R8：幂等键只覆盖单次 submit 调用，不一定覆盖进程级恢复

需要确认以下场景：

```text
服务端已接受
→ 客户端在收到响应前崩溃
→ Supervisor 重启
→ 同 Tick 再次提交
```

推荐幂等键由稳定字段派生并进入 telemetry：

```text
runId / tenantId / tick / planHash
```

而不是重启后重新生成随机值。

---

## R9：World 必须在 Tick 开始时快照化

MapStore、控制命令或后台任务可能在 Agent 运行时更新 World。

SafetyPlanner、prompt builder 和 validator 必须使用同一个 immutable `DecisionContext`，不能在一个决策过程中读取不同版本的记忆。

---

## R10：配置变更不能在 Tick 中途生效

控制面调整参数时应：

```text
接收命令
→ 写 pending config
→ 下一 Tick 边界应用
→ configVersion +1
```

不能让 SafetyPlan 使用旧配置、Agent prompt 使用新配置、validator 再使用另一份配置。

---

# 六、最终裁决

项目不需要重写，也不需要引入更复杂的多 Agent、消息队列或微服务。

最合理的终态是：

```text
4 个隔离 Tenant Node 进程
        │
        ├── arena-hero-ts
        ├── immutable DecisionContext
        ├── deterministic SafetyPlanner
        ├── DecisionCoordinator
        │     ├── DecisionLease
        │     └── PiAgentRuntime adapter
        ├── MapStore Worker
        └── telemetry / health

一个独立 Supervisor
        ├── 账号锁
        ├── 生命周期
        ├── 聚合控制面
        └── restart / backoff
```

当前最优实施顺序是：

> **CI 和生产构建 → W3 序列回放 → W4 无 Pi 决策核心 → Pi Adapter → Supervisor/Map Worker → 真机切换 → 删除 Python**

最重要的原则只有三条：

1. **SafetyPlan 必须在等待 Agent 前就已经准备好。**
2. **先让 Lease 过期，再清理 Agent；不能为 abort 阻塞提交。**
3. **Pi 只能提交候选，arena-agent 永远保留最终执行权。**
