# PROGRESS — 融合线执行记录（rust-rewrite worktree）

> 每节 = 一个融合线任务的执行记录（追加小节，不删历史）。

## F4（2026-08-06）：decisionMode=deterministic-rust 接线 ✅

- **地界**：仅 `cmd/arena/tenant.go` + 新增 `cmd/arena/tenant_ffi_test.go`。未动
  `internal/runtime/loop.go`、`internal/strategy/*`、sim-rs 任何文件、其他 cmd/*。
- **改动**（已提交 `7ec3757`）：
  - planner 构造处按 `DecisionMode` 分支：`deterministic-rust` → `strategy.NewFfiPlanner(plannerConfig, ffiLibPath, logger)`；
    其余（deterministic 等）保持 `strategy.NewPlanner(plannerConfig)` 不变。
  - ffiLibPath 解析（`resolveFfiLibPath`）：环境变量 `ARENA_FFI_DLL` 优先 →
    默认 `<baseDir>/<tenantID>/arena-sim-ffi.dll`（baseDir 缺省 runtime =
    `runtime/<tenantID>/arena-sim-ffi.dll`，与 run 目录同根）。
  - `defer loop.Close()` 之后：planner 为 `*strategy.FfiPlanner` 时 defer `Close()`
    （LIFO 先于 loop.Close，释放 Rust 句柄与 dll；空句柄为 no-op）。
  - 启动日志新增 `planner=rust-ffi|go-native`（从实际类型推导，不重复分支）。
  - 未新增配置字段；decisionMode 默认值保持 `deterministic`；manifest 的
    DecisionMode 自动携带新值（BuildManifest 复用 configFile.DecisionMode）。
- **测试**：`resolveFfiLibPath` 默认路径 / 环境变量覆盖；missing lib 时
  `NewFfiPlanner` 不 panic、类型保持 `*strategy.FfiPlanner`、Close 安全；
  编译期断言 `FfiPlanner` 满足 `runtime.Planner`。
- **验收**：
  - `go build ./cmd/... && go vet ./cmd/arena/` → BUILD_OK
  - `go test -count=1 ./cmd/arena/` → ok（全部 PASS）
  - 未跑真实 tenant（本地 t1/t2 live 在跑，不干扰；且需 token env）。
- **备注**：commit `7ec3757` 同时包含 `sim-rs/docs/plan/arena-hero-v2.md`
  （非 F4 地界文件，由提交方一并合入，与本任务无关）。gofmt -l 会列出全部
  cmd/arena 文件（仓库 autocrlf=true 工作树 CRLF 的既有噪声，与本次改动无关；
  新文件 tenant_ffi_test.go 为 LF，gofmt-clean）。
- **遗留观察**：loop.go 的"deterministic 非法动作立即停止"红线只匹配
  `decisionMode == "deterministic"`；`deterministic-rust` 模式下 Rust 内核产出
  非法动作会走 repair 而非停止。fail-safe 设计下两内核行为应一致，但该边界
  留给融合线后续（F3 shadow 双跑 PARITY 是兜底手段），F4 按任务边界未改 loop.go。

## F3（2026-08-06）：shadow 双跑验证工具 ✅（含 PARITY 差异登记）

- **地界**：仅新增 `internal/strategy/shadow_planner.go`、
  `internal/strategy/shadow_planner_test.go`、`cmd/simshadow/main.go`、
  `cmd/simshadow/main_test.go`。未动 planner/ffi/loop/tenant、sim-rs 代码、go-rewrite。
- **改动**：
  - `ShadowPlanner`（实现 runtime.Planner）：包装 Go 原生 `*Planner` + Rust
    `*FfiPlanner`；Decide 先 go 后 rust、逐字段对比（单位动作集合：ID 集合 +
    每单位 Kind/Direction/TargetID；core 存在性 + Kind/UnitType；intents 相等；
    plan tick 一致性），写 decision.jsonl（`{"tick","match","go","rust","diff"}`），
    **返回 goPlan**（shadow 只观察）；ApplyDirective 双转发；Close 关文件 +
    rust 句柄；`Stats()` 暴露 matched/diverged/firstDivergenceTick；
    FfiPlanner 处于 fallback 时构造警告"对比是 Go-vs-Go"（诚实性提示）。
  - `cmd/simshadow`：`--scene <glob>`（默认 runtime/scenes/*.json）、
    `--ticks N`（默认 100）、`--out <dir>`（默认 runtime/shadow/）；场景加载照抄
    simrun（sceneFile/tickStateJSON）；每场景 CloneState → Engine+Refill 闭环
    （SettleInPlace，同 batch 语义）→ 每 tick shadow.Decide；stdout 汇总行
    `shadow: <scene> <ticks> ticks: matched=N diverged=M first_divergence=tick`；
    ARENA_SIM_FFI_DLL 缺失 → 打印说明退出 1。
  - 测试：对比器单测（match 大小写：map 乱序同语义 → match；diverges：
    kind/direction/ID 差集/core/intents → 逐项可读）；mock rust planner 注入
    （内部真实 planner + worker-full 翻 WAIT）→ Decide 返回 goPlan、match=false、
    diff 非空、jsonl 落盘、统计正确（反向验证）；真实 dll 集成
    （cmd/simshadow 包，避开 sim→strategy import cycle；50 tick 断言全 match +
    jsonl 行数）。
- **验收**（两条命令全过）：
  - `go test ./internal/strategy/ -run TestShadow -v` → 3 PASS
  - `go run ./cmd/simshadow --scene 'runtime/scenes/*.json' --ticks 50` →
    `shadow: total 3 scenes 150 ticks: matched=150 diverged=0 first_divergence=-`
  - `go test ./cmd/simshadow/`（真实 dll 集成）→ PASS
  - vet：我的文件无警告（package 级 vet 仅剩既有 ffi_planner_windows.go
    unsafe.Pointer 3 条，F2 接缝文件、不在 F3 地界）；gofmt 内容干净
    （gofmt -l 全列 = 仓库 autocrlf CRLF 既有噪声，与 F4 备注一致）。
- **PARITY 差异登记（长程 divergence，500 tick 探测，2026-08-06）**：
  短程（≤50 tick，150 tick 全 match；集成测试 50 tick 全 match）无差异；
  长程出现语义漂移，**按任务纪律未改任何 planner 代码**，如实登记：
  - base 500t：matched=434 diverged=66，首差异 t435；dense 500t：matched=182
    diverged=318，首差异 t183；sparse 500t：matched=384 diverged=116，首差异 t275；
    合计 1500t：matched=1000 diverged=500。
  - 首个差异形态：dense/base 为 `unit sim-VANGUARD-14: go=MOVE(patrol)
    rust=HEAL(to_core_heal)`——Go/Rust 都有 to_core_heal 概念，差异在触发条件
    （Rust 在 Go 仍巡逻的状态下把残血 Vanguard 送回家）；sparse 为
    `sim-WORKER-6: go=WAIT rust=MOVE(LEFT)`。
  - 差异持续性：base 为 1 段持续 streak（t435→结束），dense 为 1 段持续
    streak（t183→结束），主模式均为 `go=patrol rust=to_core_heal`
    （Vanguard 治疗回撤触发条件漂移，多单位同 tick 叠加）；sparse 为 15 段
    短 streak（t275–476），主模式为同 MOVE 不同 direction——巡逻螺旋方向漂移。
  - 结论：F2 单 tick 一致性成立；长程漂移集中在"单位受伤后的治疗回撤路径
    （heal 触发条件）"与"巡逻螺旋扫描方向"，属 Go/Rust planner 实现语义漂移。
  - **用户决策（2026-08-06）**：不追齐 Go/Rust 策略一致性——融合线即将重写
    重构策略（arena-hero-v2 v0.1-v0.5），Rust 侧自主适配优化；F3 语义从
    "一致性门禁"转为"差距度量基线"：差异不消除，登记在案作为 Rust 演进
    参照；shadow 工具保留为后续每次策略改动的回归度量（同样接受差异）。
    同日决策：**纯 Go 线转向融合线**（go-rewrite 停止独立演进，融合线为唯一
    终态，Go 宿主 + Rust 决策内核）。
- **产物**：`runtime/shadow/<scene>-decision.jsonl`（50t 验收 + 500t 长程
  `runtime/shadow/long/`，runtime/ 为 gitignore，未入库）。
- **遗留**：divergence 未修（任务边界）；dll 集成测试依赖 ARENA_SIM_FFI_DLL
  环境变量（缺失 skip）。
