# Pure Rust 任务分解

> 当前实施 backlog。P0=生产安全必需，P1=策略收益，P2=成熟后优化。每项必须独立提交和验证。

## R0 — 收口与清理

| ID | 任务 | 优先级 | 验收 | 状态 |
|---|---|---:|---|---|
| R0-1 | 归档 Fusion 计划/进度 | P0 | 所有 active SSOT 指向 Pure Rust | 进行中 |
| R0-2 | 盘点 `ffi` / Go Host / fallback 引用 | P0 | 清单含调用者、fixture、删除条件 | 待做 |
| R0-3 | 提取协议/锁/幂等/reconnect/死锁 fixture | P0 | Rust 测试可消费，不依赖 Go runtime | 待做 |
| R0-4 | workspace 全门禁 | P0 | fmt + clippy -D warnings + test | 待做 |
| R0-5 | 移除 `crates/ffi` 出正式 workspace | P0 | 无动态库/Go 运行依赖 | 待做 |

## R1 — Hero Client 与协议

| ID | 任务 | 优先级 | 验收 |
|---|---|---:|---|
| R1-1 | 新建 `crates/client` 与 strict wire DTO | P0 | 真实 fixture parse；未知/非法字段 fail closed |
| R1-2 | HTTP submit + receipt/error 分类 | P0 | 202/400/409/5xx/network 测试；幂等键稳定 |
| R1-3 | WebSocket event stream | P0 | tick/state/received、close、binary、auth、protocol error |
| R1-4 | reconnect + idle timeout | P0 | 断流恢复，重放 Tick 不重复交给 planner |
| R1-5 | DTO → `domain::TickState` normalization | P0 | canonical hash 与 fixture 稳定 |
| R1-6 | shadow CLI | P0 | t3/t4 100 唯一 Tick，0 submit/panic/mismatch |

## R2 — Tenant Runtime

| ID | 任务 | 优先级 | 验收 |
|---|---|---:|---|
| R2-1 | 新建 `crates/runtime` | P0 | client→world→decide→validate→telemetry 链通 |
| R2-2 | planning 前 exactly-once | P0 | 重复/倒序 Tick 仅一次 decision，unique tick 计数 |
| R2-3 | single-writer lock | P0 | 活锁拒绝、陈旧锁策略、PID reuse/跨平台测试 |
| R2-4 | live 双确认与 max tick | P0 | 未双确认拿锁前 fail-fast；唯一 Tick 精确终止 |
| R2-5 | fatal error semantics | P0 | invalid/repair/submit reject/panic 立即非零退出 |
| R2-6 | shutdown cleanup | P0 | SIGINT/timeout 后锁、任务、socket、writer 全释放 |
| R2-7 | manifest/JSONL/secret redaction | P0 | git/profile/rules/hash 齐全，凭据不落盘 |
| R2-8 | settlement diagnostics | P0 | resources/workers/cargo delta、spawn no effect、stall |

## R3 — Economy / World

| ID | 任务 | 优先级 | 验收 |
|---|---|---:|---|
| R3-1 | ResourceMemory | P1 | 采空/失败/TTL/cooldown，不反复撞空点 |
| R3-2 | 全局 Worker 分配 + sticky | P1 | 一资源一 Worker；目标无明显收益不切换 |
| R3-3 | Worker 生命周期 | P1 | harvest→return→deposit 完整 trace |
| R3-4 | 满仓 Core 破锁 | P0 | cargo Worker 让位，spawn/deposit 后状态 delta |
| R3-5 | move reservation | P1 | 格容量、Core 入口、依赖链、loser 改道 |
| R3-6 | population/reserve/respawn | P1 | workerTarget、spawn reserve、恢复优先 |
| R3-7 | dropped cargo recovery | P1 | 安全且有回程价值时回收 |

## R4 — Exploration / Navigation

| ID | 任务 | 优先级 | 验收 |
|---|---|---:|---|
| R4-1 | chunk/frontier age | P1 | 多单位不重复长期扫同区 |
| R4-2 | 稳定扇区与连续外扩 | P1 | 覆盖 8/16/24/32/40，无跨图横跳 |
| R4-3 | blacklist/封闭区剪枝 | P1 | 无价值/不可达区域短期不重试 |
| R4-4 | bounded A*/BFS | P1 | 长墙/窄口可达，无决策长尾 |
| R4-5 | route hysteresis / loop removal | P1 | 无 A-B-A、无一格临时目标退化 |
| R4-6 | 敌占格与风险路径 | P1 | 回仓不穿敌方 UNIT/Core 格 |

## R5 — Threat / Core / Combat

| ID | 任务 | 优先级 | 验收 |
|---|---|---:|---|
| R5-1 | EnemyMemory + visibility exclusion | P1 | 消失不等于死亡；视野确认后删除 |
| R5-2 | stationary/active + reachable set | P1 | 静止不乱预测，活跃威胁有 ETA |
| R5-3 | Core defense | P1 | 多轴守卫、回防边界、恢复与逃生 |
| R5-4 | force composition | P1 | defensive/aggressive 场景自适应 |
| R5-5 | predictive fire / pursuit / retreat | P1 | 有限候选格、Miss 修正、低血撤退 |
| R5-6 | flank/block/raid | P2 | 有界包抄和 confirmed stationary raid |

## R6 — Replay / Optimization / Promotion

| ID | 任务 | 优先级 | 验收 |
|---|---|---:|---|
| R6-1 | StrategyProfile adapter | P0 | TS/Rust 同一 profile，unsupported 显式上报 |
| R6-2 | RaceResult v2 | P0 | hard gates/metrics/evidence schema 有效 |
| R6-3 | Runtime-Golden replay | P1 | rule mismatch/unknown/bug 分类明确 |
| R6-4 | search/optimizer | P2 | paired seeds + p10，不以最好 seed 晋级 |
| R6-5 | t3/t4 staged promotion | P0 | shadow→3/10/30/100→canary/soak |
| R6-6 | first t1/t2 migration | P0 | 单租户切换 + TS rollback 演练 |

## 提交与测试规则

- 一个 ID 一个原子提交；
- 共享 `domain`、Cargo manifest/lock 同一时间一个 owner；
- 策略任务附 scenario/seed/tick/baseline/mean/p10/failure rate；
- runtime 任务附故障注入或真实 replay；
- 不 `.skip`、不放宽 validator、不覆盖失败 golden；
- 不为旧 Go/Fusion CI 继续偿债；
- R1/R2 未完成前不扩高级战斗、LLM 或部署平台。
