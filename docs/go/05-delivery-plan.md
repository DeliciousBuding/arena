# 编排计划（05）—— 纵向可运行切片

> 状态：2026-08-05 修订。原"十批次全模块横向铺开"改为**纵向闭环优先**：
> 先跑通真实服务器闭环，再按真实需求补齐外围模块。
> 已完成的横向成果（contracts/llm/telemetry/mapstore）全部保留，不返工。

## 1. 总体裁决

- **Go 负责 Arena 的身体、神经和反射；模型框架只是可更换的大脑插件**；
- 核心（Hero/domain/planner/lease/validator/submit）自研 Go；
- 模型传输：当前自研客户端 → 后续 OpenAI SDK Adapter（`BaseURL` 指向 NewAPI）；
- 通用 Tool Agent：有真实需求后评估 Eino；多 Agent/A2A/Google Cloud：评估 ADK；
- 外部 MCP：用官方 MCP Go SDK；Simulator：近期复用 TS（TS Simulator = 研究 Oracle，
  Go Runtime = 真机执行）；
- 不砍长期能力，只是延后选择；核心接口已预留可插拔边界（见 §3）。

## 2. 五个纵向阶段

### 阶段 A：Go deterministic replay（fixture 闭环）

```text
fixture → decode → reduce → deterministic planner → validate → 输出 plan
```

- **验收**：100 tick 完整回放不 panic；输出全过 Validator；主要动作类型与 TS 一致；
  差异分类记录（不强制逐字节一致）；关键场景清单全过（见 04 §4）。
- 不需要：Supervisor / AgentLoop / mapstore 主链 / Digital Twin / Docker / MCP。

### 阶段 B：真机 shadow 闭环（提前执行，不等模块全齐）

```text
hero WS → TickState → Planner → Validator → 生成但不 submit → 最小 JSONL
```

- **验收**：t3 稳定连接；Tick 连续推进；无阻塞/goroutine 泄漏；每 Tick 合法 Plan；
  deadline 不超；日志不泄密。
- 只接 `runtime.jsonl` + `decision.jsonl`；MapStore 处于 implemented-not-critical-path。

### 阶段 C：bounded live canary

补齐：单写者锁、幂等键、DecisionLease、基础 reconnect、submit receipt、bounded ticks。

```text
arena tenant --tenant=t3 --live --max-ticks=N
```

- **验收**：接受率 / 非法动作数 / 资源变化 / 超时数 / 重连后是否重复提交。

### 阶段 D：MacroPolicy（LLM 战略层）

```text
每 32 Tick → PolicyInput → 一次 JSON 输出 → 校验 → sticky
```

- 不做工具循环/通用 Session/arena_map/多 Agent；
- **验收**：三组对照（deterministic / deterministic+fixed policy / deterministic+LLM
  policy），确认 LLM 有正收益后才扩张智能层。

### 阶段 E：生产能力（按真实故障和收益补）

Supervisor、health/ready、Docker、systemd、telemetry rotation、mapstore 主链、
多租户、更完整 AgentLoop、Digital Twin——按运行暴露的问题逐个补，不按文档顺序铺。

## 3. 可插拔接口（核心稳定边界）

```go
type Planner interface {           // 确定性规划（核心自研）
    Decide(ctx context.Context, state *TickState, policy *MacroPolicy) (*Plan, error)
}
type PolicyEngine interface {      // 宏观策略（模型层可插拔）
    DecidePolicy(ctx context.Context, input PolicyInput) (MacroPolicy, error)
}
type CandidateSource interface {   // LLM 候选（AgentLoop 未来接入点）
    Propose(ctx context.Context, req DecisionRequest) (*Plan, error)
}
type ModelProvider interface {     // 模型传输（OpenAI SDK/Eino/ADK adapter 换装点）
    Generate(ctx context.Context, req ModelRequest) (ModelResponse, error)
}
```

未来换框架只是构造阶段差异（`switch cfg.PolicyBackend { case "native": ... case "eino": ... }`），
Arena Core 完全不变。

## 4. 推进顺序（立即执行）

```text
1. hero 最小 WS client        （本批直做）
2. domain 最小 reducer        （fixture 验证）
3. deterministic/safety planner
4. validator
5. 最小 runtime loop
6. arena tenant --shadow      （本地 fixture smoke）
7. 真机 t3 shadow
8. bounded live（经用户确认）
9. MacroPolicy（internal/llm 已有）
```

## 5. 门禁分层（04 §1 详细命令）

| 层 | 命令 | 内容 | 用途 |
|---|---|---|---|
| 快速循环 | `scripts/check-fast.sh` | gofmt + 受影响包 test + go build | 开发反复跑（几十秒） |
| Commit 级 | `scripts/check.sh` | gofmt + vet + 全 test + build + fixture smoke | 每次提交 |
| Merge/Nightly | `scripts/check-full.sh` | + race + staticcheck + govulncheck + 完整回放 + Docker + 秘密扫描 + 黑盒 + 覆盖率报告 | CI/发布 |

## 6. 红线（保留不变，其余服务迭代）

- Agent 没有 submit 权；同租户一个 live writer；密钥不落盘；非法 Plan 不提交；
  live 必须有界、可停、可回滚；
- 取消：硬覆盖率阈值 / 每批 L3 全审 / 测试数量门禁 / 每批全量差分。
  改为：关键场景清单（04 §4）+ 只对 submit/lock/lease/密钥/live 做严格审查。
