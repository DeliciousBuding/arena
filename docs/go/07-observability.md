# 可观测性架构（07）

> 状态：设计定稿（2026-08-05）。目标：统一日志/指标/溯源/诊断事件，
> 让任何运行问题（卡顿、死锁、断流、错误潮）可自动发现、可溯源、可复现。
> 原则：轻量、约定优于配置、分级告警、**默认开启**（不依赖 --debug 才发现问题）。

## 1. 分层

```text
internal/obs/
├── obs.go        Obs：聚合句柄（logger + metrics + 溯源字段 + 诊断事件）
├── metrics.go    计数器/仪表（原子，无锁）
├── events.go     诊断事件命名与级别约定
└── watchdog.go   卡顿/死锁检测器（可配置阈值）
```

依赖方向：`obs` 零依赖（只依赖 slog）；`runtime/hero/tenant` 依赖 `obs`。

## 2. Obs 聚合句柄

```go
type Obs struct {
    log     *slog.Logger   // 结构化日志（含 runID/tenant 溯源字段）
    metrics *Metrics
}
```

- 构造：`obs.New(runID, tenantID, sink, level) *Obs`
- 溯源：runID/tenantID 自动注入每条日志（`logger.With`），**所有组件共用同一 Obs**；
- 指标：`o.Metrics()` 返回指针，组件自增（tick/submit/reconnect/error 分类）；
- 诊断事件：`o.Event(level, name, attrs...)`——事件名固定约定（见 §4）。

## 3. Metrics（原子计数器/仪表）

| 指标 | 类型 | 语义 |
|---|---|---|
| ticks_processed | counter | 已处理 tick |
| submits_accepted / submits_rejected | counter | 提交结果 |
| reconnects | counter | WS 重连次数 |
| errors_total | counter | 错误总数（分类见下） |
| last_tick_gap_ms | gauge | 最近两 tick 间隔（卡顿检测） |
| handle_state_ms | gauge | 最近 handleState 耗时 |
| idle_dumps | counter | 静默栈 dump 次数 |

错误分类（errors_total 带 label）：`config/transport/protocol/lease/lock/submit_rejected`。

## 4. 诊断事件约定（事件名 = 小写 snake_case，级别固定）

| 事件 | 级别 | 触发 |
|---|---|---|
| `ws.connected` / `ws.read_ended` / `ws.reconnect` | debug/info | 连接生命周期 |
| `ws.idle_timeout` | warn | 静默超阈值强制断流 |
| `tick.processed` | debug | 每 tick（含 gap_ms） |
| `tick.gap_warn` | warn | tick 间隔 > 45s（服务器停顿或客户端卡） |
| `handle_state.slow` | warn | handleState > 500ms（含各阶段耗时） |
| `idle.dump` | warn | 30s 无事件全栈 dump |
| `submit.accepted` / `submit.rejected` | info/warn | 提交结果（rejected 带错误分类） |
| `planner.repair` | error | deterministic 非法动作（即停） |
| `error.classified` | warn/error | 任何分类错误首现 |

级别策略：**问题可发现性优先**——断流/卡顿/错误用 warn+（不依赖 --debug）；
周期正常事件用 debug。运行模式（shadow/live）自动附加到日志字段。

## 5. watchdog 分级（死锁/卡顿自动发现）

| 级别 | 阈值 | 动作 |
|---|---|---|
| gap 警告 | tick 间隔 > 45s | `tick.gap_warn`（区分服务器停顿：记录最后 tick 与当前时间） |
| 静默 dump | 30s 无任何事件 | `idle.dump`：全 goroutine 栈（64KiB）写日志 + 独立文件 `runtime/<tenant>/dumps/idle-<run>-<n>.stack` |
| 静默升级 | 60s 无事件 | dump 计数 + `idle.dump_escalated`（重复告警，防淹没） |
| handleState 慢 | > 500ms | `handle_state.slow`（各阶段耗时；正常 0ms） |

dumps 文件 gitignored（runtime/ 已忽略）。**栈文件可复现**：含全部 goroutine 与调用点。

## 6. 溯源链

- runID 贯穿：manifest.json → 日志（每行 run_id）→ JSONL（tenant/run 目录）→ dumps 文件；
- tick 级溯源：decision/runtime JSONL 的 tick 字段 + 日志 tick 字段；
- 错误溯源：`error.classified` 事件带 `first_seen_at` + 计数，连续同类错误（≥3）升级为 error 并记录错误现场（最近 N 条相关日志摘要）。

## 7. 落地范围（本批）

1. `internal/obs` 包实现 + 单测（metrics 并发/事件级别/溯源注入）；
2. `runtime.Loop` 接入：gap 检测、handleState 慢检测、idle dump 分级与文件落盘、
   submit 事件、planner.repair 事件；
3. `hero.Client` 接入：连接/断流/重连/idle_timeout 事件（替换现有零散 logDebug）；
4. `tenant` 接入：Obs 构造、runID 注入、错误分类事件；
5. 真机验证一轮 shadow + 一轮 live（确认事件流正确、无回归）。

## 8. 不做什么（防膨胀）

- 不做 tracing 系统/OpenTelemetry（Go 原生 slog + 事件约定足够）；
- 不做外部监控端点（doctor 命令承载人工检查）；
- 不把 dump 自动上报（本地文件即可，public 仓库不建外呼）。
