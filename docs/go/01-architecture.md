# Go 架构总览（01）

> 状态：设计定稿（2026-08-05）。本文件定义 Go 版模块边界、数据流与关键设计决策。
> 模块级细节与验收见 `03-module-spec.md`；契约见 `02-contracts.md`。

## 1. 仓库布局

```text
go.mod                          # module arena；Go 1.26；零 CGO
cmd/arena/                      # 单一入口：所有子命令（supervisor/tenant/doctor/version/…）
internal/
├── contracts/                  # 契约层：wire/domain/decision 类型 + canonical JSON + 黄金对齐
│   ├── wire/                   #   WS 原始协议（与服务器字节级兼容）
│   ├── domain/                 #   规范化 TickState / Plan / 单位类型
│   └── decision/               #   LLM 候选计划协议（arena_plan 工具契约）
├── hero/                       # 游戏协议客户端（WS 连接、Turn 流、submit）
├── domain/                     # 领域逻辑：state-reducer、world、nav、phase、validator、hash
├── strategy/                   # SafetyPlanner、DeterministicPlanner、任务分配
├── runtime/                    # DecisionLease、LeaseRegistry、DeadlineBudget、Coordinator、Arbiter、loop
├── agent/                      # AgentLoop + Harness（session、工具注册、循环、budget、abort）
├── llm/                        # 统一 LLM 客户端（SSE 流式、模型路由、重试/退避、熔断）
├── mapstore/                   # SQLite WAL 跨进程增量同步（知识层）
├── telemetry/                  # JSONL 三流 + policy + manifest + 递归脱敏 + Runtime-Golden recorder
├── ops/                        # 单写者锁、supervisor、health/ready、进程树管理、信号
├── sim/                        # Digital Twin（规则结算引擎，W10 前置，批次 7）
├── policy/                     # MacroPolicy 类型/值域/规范化/序列化（与 TS 语义兼容）
└── version/                    # 版本与构建信息（-ldflags 注入）
scripts/                        # 门禁脚本（go-check 等）+ 保留的 shell 运维资产
fixtures/                       # Golden fixture（数据，只读）
contracts/generated/            # JSON Schema 黄金文件（数据，只读）
deploy/                         # systemd 单元、compose、rollback（Go 批次适配）
```

依赖方向：`contracts ← domain ← strategy ← runtime`；`hero`、`agent`、`llm`、
`mapstore`、`telemetry` 挂在 `runtime` 之下；`ops` 与 `cmd` 在最外层。
`internal/` 防止包外滥用；公开 API 仅在将来需要时提升。

## 2. 每 Tick 决策链路（W4 coordinator 语义，Go 表达）

```text
hero.TurnStream (WS)
  → contracts: wire → domain (reducer，immutable TickState)
  → runtime.Coordinator.decide(state)
      ├─ strategy.SafetyPlanner 预计算（确定性基线，立即完成）
      ├─ agent.AgentLoop（可选）经 DecisionLease 提交候选（goroutine，abort 感知）
      ├─ deadline race：select { leaseResult, deadlineTimer }（无需轮询）
      ├─ runtime.PlanArbiter 合成（hybrid/emergency）
      └─ expired/cancelled → 立即 Safety 兜底
  → domain.ValidatePlan（语义校验 + per-action repair）
  → hero.Turn.Replace → hero.Submit（幂等键）
  → telemetry（runtime/decision/outcome JSONL）
```

与 TS 版的差异（有意为之）：

1. **deadline race 用 `select` + `time.Timer`**，替代 TS 版 10ms 忙轮询（W7 路线里 TS 版也
   计划改事件驱动，Go 原生表达，零 CPU 浪费）；
2. **AgentLoop 是独立 goroutine**，abort 用 `context.Context` + 流关闭，天然表达
   "迟到的候选被 Lease 拒绝"（Lease 状态机不依赖调用方自觉）；
3. **所有共享状态显式通过 channel/immutable 结构传递**，配 `go test -race` 全绿门禁，
   从根本上消除数据竞争类缺陷。

## 3. AgentLoop + Harness 设计（贴合游戏，参考 pi 分层）

参考 `earendil-works/pi` 的分层（`pi-ai` → `pi-agent-core` → 编码 agent CLI），
Go 版对应设计：

```text
internal/llm/
  Client        统一流式 LLM 客户端：OpenAI-completions SSE；多 provider 路由
                （newapi 网关 baseUrl 可配）；流事件解析；context abort；
                指数退避重试；熔断器（closed→open→half-open）
  Model         模型描述（provider/id/baseUrl/compat/maxTokens/…），从配置构建

internal/agent/
  Session       一次 agent 会话：消息历史、模型绑定、思考级别、abort 语义
  Loop          受控循环：prompt → 流式生成 → 工具调用 → 注入结果 → 再生成
                轮数与 token budget 上限；abort/timeout 后会话可复用
  ToolRegistry  工具注册表：name/description/schema/execute；零内置工具
                （对齐 TS 版 noTools:"all" + 白名单的语义）
  Harness       arena_plan / arena_map 游戏工具（见 §4）

internal/policy/  低频 MacroPolicy 决策（无工具 loop）：宏观状态 → 策略 JSON
```

**Agent 与决策核心的边界（红线 2）**：

- `arena_plan` 工具只向**当前 DecisionLease** 提交候选计划（runId/tick/stateHash 三重校验），
  不直接操作游戏；`arena_map` 只读当前视野快照；
- Loop 返回后，Lease 校验/仲裁/合法性检查/提交权全在 `runtime` 包；
- 迟到/越权调用由 Lease 拒绝并上报 violation 遥测——与 TS 版同一语义，Go 实现更直接。

## 4. 游戏 Harness 工具契约

| 工具 | 输入 | 输出 | 权限 |
|---|---|---|---|
| `arena_map` | 无（用 session 上下文） | 视野/地图快照（脱敏后） | 只读 |
| `arena_plan` | 完整候选 plan（units/core actions） | accept / reject(reason) | 只写当前 Lease |

工具实现在 `internal/agent/harness/`，通过接口与 `runtime.LeaseRegistry` 对接，
**不 import 游戏客户端**——保证工具层永远无法绕过决策核心。

## 5. 决策模式与运行模式（配置驱动，默认安全）

| 模式 | 含义 | 默认 |
|---|---|---|
| `deterministic` | SafetyPlanner + DeterministicPlanner，无 LLM | 生产默认 |
| `agent-shadow` | 决策链同 live，但 submit disabled（只观察） | 验证用 |
| `hybrid` | deterministic + LLM 候选仲裁 | 显式开启才用 |
| `safety` | 仅 Safety 兜底 | 降级路径 |

提交模式独立两轴：`shadow`（不提交）/ `live`（提交），与决策模式正交
（对齐 TS 版 DecisionMode/SubmissionMode 分离设计）。

## 6. 遥测与 manifest（与 TS 版格式兼容）

- `runs/<processRunId>/manifest.json`：gitSha、schema hash、模型、配置 hash、租户、模式；
- `telemetry/{runtime,decision,outcome,policy}.jsonl`：append-only、行级原子写、
  递归脱敏；字段命名与 TS 版一致（W9 数据平台兼容）；
- Runtime-Golden recorder：`calibration/<runId>/` 旁路记录（默认关闭）。

## 7. 部署形态

- `arena` 静态二进制（CGO_ENABLED=0），`FROM scratch` 或 `distroless` 镜像
  （原 node:24-slim ~数百 MB → 目标 <30MB）；
- systemd 单元复用现有结构（shadow `Restart=on-failure`、live `Restart=no`）；
- 健康探针：`arena doctor` + `/health` `/ready` HTTP（与现有 check-readiness.sh 兼容）；
- 单写者锁语义不变（`<tenant>/locks/<tenant>.lock` 原子创建 + PID/starttime 校验）。

## 8. 关键设计决策记录（ADR 摘要）

| 决策 | 选择 | 理由 |
|---|---|---|
| SQLite | modernc.org/sqlite（纯 Go） | 零 CGO、跨编译、WAL 语义兼容；负载低频，性能差异无关紧要 |
| WebSocket | coder/websocket | 纯 Go、context 原生、维护活跃；gorilla 已进入维护冻结 |
| LLM 客户端 | 手写 SSE 解析（net/http） | 协议简单（OpenAI-completions），零框架依赖，便于精确控制 abort/熔断 |
| CLI | 标准库 flag + 子命令分发 | 命令集小（≤8 个），不引 cobra 依赖 |
| 日志 | slog JSON handler | 标准库、结构化、与 JSONL 遥测同构 |
| 测试 | 标准库 testing（+ 手写断言辅助） | 零依赖；测试矩阵见 04 |
