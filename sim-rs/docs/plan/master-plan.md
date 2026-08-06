# Pure Rust 主线完整执行计划

> Arena 长期唯一产品实现。Issue #27 负责迁移裁决，Issue #26 负责实现总控，`../../PROGRESS.md` 记录事实进度。

## 1. 目标

Rust 直接拥有完整生产闭环，并与 replay/simulator/optimizer 共享同一套 domain、rules 和 strategy：

```text
Hero HTTP / WebSocket
→ protocol DTO / normalize
→ TickState / World memory
→ deterministic planner / validator
→ exactly-once tenant runtime
→ submit / idempotency / single-writer lock
→ telemetry / replay / simulator / optimizer
```

TS 在迁移期继续承担 t1/t2 生产、真实数据校准、策略实验、Runtime-Golden 与回滚。Go/Fusion/FFI 仅作为可提取知识，不进入运行路径。

## 2. Workspace 终态

保持少 crate、强边界，不为形式拆包：

```text
sim-rs/
├── crates/domain      # 唯一领域模型、规则、validator、canonical hash
├── crates/engine      # 纯结算、visibility、scenario、replay primitive
├── crates/strategy    # World/Memory、经济、探索、导航、威胁、战斗
├── crates/client      # 新增：Hero HTTP/WS、wire DTO、auth、receipt
├── crates/runtime     # 新增：tenant loop、lock、deadline、telemetry、manifest
└── crates/cli         # arena/shadow/replay/sim/search/doctor 等入口
```

`crates/ffi` 在 R0 完成知识迁移后移出 workspace 并归档或删除。Protocol DTO 只存在于 `client` 边界；进入系统后只使用 `domain::TickState`。

## 3. 固定设计约束

- 一个租户一个 live writer；
- 一个 Rust planner 状态所有者；
- duplicate/stale/late Tick 在 planning 前拒绝；
- deterministic invalid/repair 立即终止 run；
- 不存在 silent fallback；
- `command accepted` 与 settlement outcome 分开记录；
- LLM 仅低频输出可校验 MacroPolicy，不逐 Tick 调用、不直接 submit；
- 正式结果绑定 git/profile/rules/fixture/scenario hash；
- 官方不可观测语义标记 `INCONCLUSIVE`，不猜测；
- simulator 与生产共享纯逻辑，但 simulator 不导入网络和生产副作用。

## 4. 阶段计划

### R0 — 去 Fusion、恢复单一 SSOT

任务：

- 归档 Fusion 文档和 F3/F4 历史；
- 盘点 `ffi`、Go Host、Go fallback、`deterministic-rust` 引用；
- 提取协议/幂等/锁/reconnect/经济死锁 fixture；
- 建立 Pure Rust workspace 门禁；
- 删除或隔离会误导 Agent 的 Fusion 入口。

门禁：

```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

完成条件：当前计划不依赖 Go/FFI，Rust Agent 在 Issue #27 回执，workspace 有可复现绿色基线。

### R1 — Rust-native Hero 协议纵切

任务：

- 配置与 token 引用，secret 不落盘；
- HTTP submit、202/400/409/5xx 分类与稳定 idempotency key；
- WebSocket tick/state/received、异常关闭、idle timeout 与 reconnect；
- wire DTO 严格解析并归一化为 `TickState`；
- shadow-only CLI 与 run-scoped manifest/JSONL。

最小验收：

- raw fixture → DTO → TickState → planner → validator 完整回放；
- t3/t4 100 唯一 Tick shadow；
- 0 submit、0 panic、0 decode mismatch；
- 断流重连不重复 decide。

### R2 — Exactly-once 生产运行时

任务：

- `lastHandledTick` 在 planning/telemetry 前生效；
- `ProcessedTicks` 统计唯一 Tick；
- live 双确认；
- tenant single-writer lock；
- stable idempotency；
- deadline/stale candidate；
- submit rejection、invalid plan、panic 全部 fatal；
- SIGINT/timeout 清理 writer、锁、子任务和文件句柄；
- settlement delta、`planned_spawn_no_effect`、cargo stall telemetry。

完成条件：故障注入可证明 duplicate、second writer、repair、orphan 均被硬门禁捕获。

### R3 — 经济闭环与 World Memory

按收益顺序：

1. resource memory、耗尽与失败冷却；
2. Worker 唯一资源分配和目标粘性；
3. harvest → return → deposit；
4. Core 满仓让位与 spawn/deposit 破锁；
5. 事前 move reservation / capacity arbitration；
6. workerTarget、reserve、respawn override；
7. dropped cargo recovery。

验收场景：economy-dense、economy-sparse、resource-far、core-gate、respawn。

完成条件：0 invalid/repair，20 paired seeds 下净经济提升，最差 10% 不显著退化；真实 t3/t4 能观察到 settlement state delta，而非只看 HTTP accepted。

### R4 — 探索与导航

任务：

- chunk/frontier age；
- 稳定扇区与连续外扩；
- blacklist/不可达区域剪枝；
- A* 或 bounded BFS；
- 路线迟滞、A-B-A 环消除；
- 长墙/窄口/敌占格绕行；
- Core 入口和两容量格的时空预约。

完成条件：远资源首次发现时间下降、重复覆盖率下降、无路线振荡和超时长尾。

### R5 — Threat、Core 生存与战斗

固定顺序：

1. enemy memory 与可见性排除；
2. stationary/active 分类；
3. ETA/threat score 与安全路线；
4. Core 多轴防御与恢复；
5. Ranger/Vanguard 配比；
6. 预测攻击点、追击、撤退、堵路；
7. confirmed stationary Core raid。

完成条件：crossfire/enemy-aggressive/enemy-defensive 场景通过，Core 尾部生存不低于 TS 固定基线。

### R6 — Replay、Simulator 与搜索统一

- StrategyProfile v1 直接由 TS/Rust 两边消费；
- RaceResult v2；
- 同 seed 重放逐字节确定；
- TS Runtime-Golden 作为真实观察输入；
- official unknown 保持 `INCONCLUSIVE`；
- simsearch/optsearch/paramscan/simgolden 继续作为研究工具；
- 评分同时报告均值、中位数、p10、方差和失败率。

Go oracle 只在迁移 fixture 阶段临时保留；不再追求 Rust 与 Go 长期逐动作同构。

### R7 — 生产晋级

```text
workspace gate
→ fixture/replay
→ same-state TS/Rust shadow
→ t3/t4 24h 或 10,000 Tick shadow
→ 3/10/30/100 Tick bounded live
→ 1,000 Tick Canary
→ 10,000 Tick soak
→ 一个 t1/t2 生产 Canary
→ 第二生产租户
```

每一级 hard gates 必须全 0；失败退回 shadow。TS baseline 在 Rust 长期 Canary 完成前保持可执行。

## 5. 并行策略

当前最多三条无重叠 lane：

- Lane A：`client` + protocol fixtures；
- Lane B：`runtime` + lock/idempotency/telemetry；
- Lane C：`strategy` + simulator scenarios。

边界规则：

- `domain` schema/validator 只能由一个 owner 修改；
- `Cargo.toml` / `Cargo.lock` 同一时间一个 owner；
- 正式场景/profile/contracts 由迁移总控维护；
- 未完成 R1/R2 前不并行扩高级战斗或 LLM；
- 每条 lane 一个原子提交，合流后先跑 workspace 全门禁。

## 6. 当前直接指令

```text
收口本地 WIP并回执
→ 清掉 active Fusion 叙事
→ 盘点/冻结 ffi 与 Go 依赖
→ 建 crates/client 的 read-only Hero vertical slice
→ 建 crates/runtime exactly-once shadow loop
→ t3/t4 100 Tick shadow
→ 再进入经济闭环
```

## 7. 总完成标准

- Pure Rust 无 Go/FFI 运行依赖；
- 能直接连接服务器并长期稳定运行；
- deterministic live 无 duplicate、wrong tick、unknown repair、second writer、panic 或 orphan；
- 生产、replay 和 simulator 共享 Rust domain/strategy；
- 在统一 profile/fixture/指标下相对 TS 无安全退化；
- 至少一个生产租户完成长期 Rust Canary 和可验证 TS 回滚；
- Go/Fusion 进入 archive，TS 明确收敛为实验、Oracle 与回滚线。
