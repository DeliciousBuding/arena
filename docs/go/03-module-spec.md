# 模块规格（03）

> 状态：设计定稿。每个模块：职责、关键接口、验收标准。验收标准是派发任务的硬指标。
> 依赖顺序（实现序）：contracts → {hero, domain, telemetry} → {strategy, mapstore} →
> runtime → {agent, llm} → policy/harness → {ops, sim} → cmd 集成 → 部署。

## M1 `internal/contracts` — 契约类型与黄金对齐

- **职责**：wire/domain/decision 三组 Go 结构体、JSON 编解码、值域校验；黄金样例冻结。
- **接口**：`ParseDifferentialRecord([]byte) (*DifferentialRecord, error)`、
  `MarshalPlan(Plan) ([]byte, error)`、`ParsePlan([]byte) (*Plan, error)`、各校验函数。
- **验收**：
  - `golden_test.go`：每条 schema 的合法样例往返一致；非法样例拒绝；
  - 字段名/枚举与 TS 版及 JSON Schema 逐项一致（测试断言枚举全集）；
  - `go vet`/`staticcheck` 干净。

## M2 `internal/hero` — 游戏协议客户端

- **职责**：WS 连接生命周期（连接/重连/心跳/退避）、Turn 流订阅、Turn 构建、
  `Replace`（全量替换决策内容）、`Submit`（幂等键）、结果回执。
- **接口**：`NewClient(baseURL, apiKey, opts)`、`client.Turns(ctx) <-chan *Turn`、
  `turn.Replace(plan) error`、`turn.Submit(ctx, idempotencyKey) (*Receipt, error)`。
- **验收**：
  - 黑盒 fake WS server 测试：握手、turn 推流、replace/submit 报文断言；
  - 断线重连：中途断流 → 指数退避重连 → 恢复订阅（无重复提交）；
  - 幂等键：同 key 重复 submit 被服务器去重语义在 fake server 上验证；
  - 超时/abort：ctx 取消中断流读，goroutine 零泄漏（`go test -race`）。

## M3 `internal/domain` — 领域逻辑

- **职责**：`state-reducer`（fixture/raw → immutable TickState）、`world`（障碍/资源/敌人
  跨 tick 记忆）、`nav`（有界 BFS 最短路，margin 4/8/16/32，绕长墙防振荡）、
  `phase-machine`（early_expansion/balanced/military）、`plan-validator`（语义校验 +
  per-action repair）、`state-hash`（内容哈希）、`integrity`（canonical sha256）。
- **验收**：
  - **fixture 回放**：`burnin-20260802-a` 100 tick 全部经 reducer，state 字段与期望一致
    （期望冻结于 `testdata/expected/`，由 TS 版回放结果导出，见 04）；
  - nav：10,000 随机路径用例 invariant 通过（可达性/长度/无穿墙）；
  - validator：对每个 action kind 的非法变体逐项拒绝；repair 只改非法动作；
  - state-hash：同 state 同 hash；字段顺序无关（canonical）。

## M4 `internal/strategy` — 策略层

- **职责**：`SafetyPlanner`（确定性基线：spawn/巡逻/回仓状态机/守备；aggression 分支
  含 Vanguard 前压、Ranger 断经济）、`DeterministicPlanner`（经济闭环：WorkerTaskPlanner
  资源格全局唯一分配）、`policy`（MacroPolicy 类型/值域/规范化/序列化——与 TS 语义一致）。
- **接口**：`type Planner interface { Decide(state *domain.TickState, policy *policy.MacroPolicy) (*contracts.Plan, error) }`。
- **验收**：
  - fixture 上 planner 输出与 TS 版期望 plan 逐字段一致（期望来自 TS 版 100-tick
    回放结果冻结）；
  - aggression 分支 A/B 行为测试（aggressive vs defensive 差异断言，非真机）；
  - 计划合法性 100%（validator 后零非法动作）；
  - 确定性：同输入两次调用输出字节相同。

## M5 `internal/runtime` — 决策核心

- **职责**：`DecisionLease`（runId/tick/stateHash/deadline 三重校验）、`LeaseRegistry`
  （精确索引 + 状态机 + 有界清理）、`DeadlineBudget`（agentSoft/selection/submit/hard）、
  `Coordinator`（Safety 预计算 + deadline race + settle）、`PlanArbiter`（hybrid/emergency）、
  `loop`（turns → 决策 → 提交；startupSync/outcomeDrain 边界）、`clock`（FakeClock）。
- **接口**：`Coordinator.Decide(ctx, state) (*Decision, error)`；
  `LeaseRegistry.StartDecision(...) *DecisionLease`；`lease.SubmitCandidate(plan) Result`。
- **验收**（对齐 TS 版暗卷语义，全部 fault injection 化）：
  - stale/late/越权候选 100% 拒绝（runId 错、tick 错、stateHash 错、过期各一组）；
  - deadline race：soft 前合法候选被接受；过期 → Safety 兜底；never-settle →
    Safety 计划 100% 等值（fixture 100 tick）；
  - abort：AgentLoop 中止后迟到调用全部拒绝；
  - registry 有界清理：超量 lease 不泄漏（内存断言 + race）；
  - FakeClock 全覆盖（不 sleep 真实时间）。

## M6 `internal/llm` — 统一 LLM 客户端

- **职责**：OpenAI-completions SSE 流式调用；模型路由（provider/baseUrl/id）；流事件
  解析（delta 聚合、`[DONE]`、错误段）；指数退避重试（幂等请求）；熔断器
  （closed→open 连续失败≥3 / 冷却 → half-open 单探测）；context abort 即时断流。
- **接口**：`client.Complete(ctx, req ChatRequest) (Stream, error)`；
  `stream.Next() (Chunk, error)`；`stream.Close()`。
- **验收**：
  - httptest fake provider：流事件聚合正确（多 delta 拼接）、`[DONE]` 终止、
    错误段上抛、中段断流可恢复错误分类；
  - 熔断状态机：3 连败 → open → 冷却 → half-open 单探测 → 恢复/再 open；
  - abort：ctx 取消后 100ms 内流关闭（不泄漏 goroutine）；
  - 与真实 newapi 网关的冒烟测试（可选、手动、密钥不落盘）。

## M7 `internal/agent` — AgentLoop + Harness

- **职责**：`Session`（消息历史/模型/思考级别/abort 语义/复用）、`Loop`（受控循环：
  生成 → 工具调用 → 注入 → 再生成；轮数与 token budget 上限）、`ToolRegistry`
  （零内置工具 + 白名单注册）、`harness`（`arena_plan`/`arena_map` 游戏工具）。
- **接口**：`agent.NewSession(cfg, tools, llmClient) (*Session, error)`；
  `session.Prompt(ctx, text) (*Result, error)`；`session.Abort()`；`session.Reuse()`。
- **验收**：
  - fake LLM：工具调用循环正确（模型请求工具 → 执行 → 结果回注 → 二轮生成）；
  - budget：轮数超限/超时 → 中止并返回已得结果（sticky 语义由调用方处理）；
  - abort 后复用：同一 session 二次 Prompt 正常（对齐 TS 版 W0 验证语义）；
  - harness 工具：`arena_plan` 提交到 fake Lease 全链路（accept/reject/迟到拒绝）；
  - 零内置工具断言（注册表初始为空）。

## M8 `internal/policy` — 低频 MacroPolicy 决策

- **职责**：宏观状态摘要 prompt 构建（与 TS 版 `buildMacroPolicyPrompt` 同文本语义）、
  输出解析（剥围栏 → JSON → 值域校验 → 规范化，语义与 TS 版 `parsePolicyText` 一致）、
  sticky 编排（失败沿用上次策略、intervalTicks、60s 超时、异步不占 tick 窗口）。
- **验收**：
  - 解析：合法/非法/围栏包裹/空输出全用例（与 TS 版 parsePolicyText 测试等价）；
  - 编排：fake LLM 下 interval 触发、失败 sticky、错误遥测回调；
  - 序列化输出与 TS 版 `serializeMacroPolicy` 逐字节一致。

## M9 `internal/mapstore` — 知识层（SQLite WAL）

- **职责**：跨进程增量同步（障碍/盟友知识层）；WAL 模式；busy_timeout；有效 mutation
  revision；并发首开锁安全。
- **验收**：
  - 双进程并发读写无 deadlock/无数据竞争（race + 压力测试）；
  - WAL pragma 断言；revision 单调；
  - 与主 event loop 解耦（独立 goroutine + channel，主路径零阻塞）。

## M10 `internal/telemetry` — 遥测与 manifest

- **职责**：JSONL 行级原子写 + 轮转（16MiB × 5 代）、runtime/decision/outcome/policy
  四流、递归脱敏、manifest 生成（gitSha/schema hash/模型/配置 hash/模式）、
  Runtime-Golden recorder（默认关闭）。
- **验收**：
  - 脱敏：构造含密钥样例，断言落盘零密钥（正则扫描）；
  - 轮转：满 16MiB 跨代正确、完整行边界；
  - 格式：字段名/顺序与 TS 版样本逐字节一致（testdata 冻结样本）。

## M11 `internal/ops` — 单写者锁与 supervisor

- **职责**：`SingleWriterLock`（原子创建 + PID/starttime 校验 + 释放）、`Supervisor`
  （全量 preflight 后 spawn、部分失败回收、health/ready 分离、IPC 优雅关闭、
  Windows/Linux 双平台进程树 kill）、`doctor`（preflight 自检）。
- **验收**：
  - 锁：同租户第二进程拿锁失败；PID 复用陷阱测试（starttime 校验）；
  - supervisor：preflight 失败 0 spawn；部分失败回收已 spawn；orphan=0（真实
    child+grandchild 黑盒，Win+Linux）；
  - ready 语义：lock PID == child PID 才 ready。

## M12 `internal/sim` — Digital Twin（W10 前置）

- **职责**：规则结算引擎（movement/economy/combat/beacon/respawn/upkeep/core 动作），
  确定性 RNG/UUID 注入；供策略锦标赛与未来 RL（本批只做核心结算与单测）。
- **验收**：已知确定性事件一致率 ≥99.9%（对 fixture events 回放断言）——本批允许
  部分未覆盖（标 unknown），但不允许误报 MATCH。

## M13 `cmd/arena` — 单一 CLI 入口

- **职责**：子命令分发：`supervisor`、`tenant`、`doctor`、`replay`（fixture 回放）、
  `version`、`sim`（可选）；config 从文件 + env（`ARENA_*`）合并；显式参数 > env > 默认。
- **验收**：每子命令 `--help` 可用；`version` 输出 ldflags 注入信息；doctor 全项自检。

## M14 部署资产（deploy/ 适配 + CI）

- **职责**：多阶段 Dockerfile（`FROM golang:1.26-alpine AS build` +
  `FROM scratch`，静态二进制）、systemd 单元适配（二进制路径/健康探针）、
  rollback 脚本适配、GitHub Actions（quality job: 全门禁；release job: 镜像推送 GHCR）。
- **验收**：本地 `docker build` 成功且镜像 <50MB；`systemd-analyze verify` 通过；
  CI quality job 全绿；`govulncheck ./...` 零告警。
