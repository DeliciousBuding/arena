# PROGRESS — Pure Rust 主线执行记录

> 当前实施 SSOT。架构裁决见 Issue #27；任务总控见 Issue #26；详细计划见 `docs/plan/master-plan.md`。
> 历史 Go+Rust Fusion 执行记录已原样归档到 `docs/archive/fusion-progress-2026-08-06.md`，不得继续作为任务入口。

## 当前状态（2026-08-06）

- 远端分支：`rust-rewrite@b95cae66562132e977bfb3a6eb7ba83e14ba996e`。
- 最近两次提交只完成协作控制面：重写 `AGENTS.md`，新增 `CLAUDE.md` 桥接；**尚未推送 Rust-native Hero client/runtime 实现提交**。
- 现有可复用 Rust 地基：`domain`、`engine`、`strategy`、`cli`。
- `ffi` crate、根目录 Go Host、Go planner、Go fallback 和动态库加载均为 legacy，不进入终态。
- 当前 workspace 仍含 `crates/ffi`；这是 R0 待移除依赖，不代表架构仍为 Fusion。
- `rust-rewrite` 当前没有对应 GitHub Actions 运行证据；本地门禁结果必须在下一原子提交回执中明确给出。

## R0 — 去 Fusion 与建立纯 Rust 纵切（进行中）

### R0.1 SSOT 清理

- [x] 根 `AGENTS.md` 明确 Pure Rust 唯一主线；
- [x] `CLAUDE.md` 桥接 Agent 规则；
- [x] Fusion 历史进度归档；
- [x] `docs/plan/` 从 Go/Fusion 叙事重写为 Pure Rust 计划；
- [ ] Pure Rust Agent 在 Issue #27 回执实际 branch/head/WIP/测试；
- [ ] 确认本机未推送 WIP，并把当前原子变更推送到 `rust-rewrite`。

### R0.2 Legacy 依赖盘点

必须逐项登记，不能边做纯 Rust 边继续维护旧接缝：

- [ ] `crates/ffi` 的调用者与可删除条件；
- [ ] 根目录 Go `cmd/arena` / `internal/runtime` / `internal/strategy/ffi_*` 中值得迁移的 fixture 和故障案例；
- [ ] Go 侧 exactly-once、stable idempotency、single-writer lock、idle reconnect、manifest/JSONL 字段；
- [ ] 旧 `deterministic-rust`、`ARENA_FFI_DLL`、DLL/SO 分发与 Go fallback 的全部引用；
- [ ] Fusion CI/文档/命令入口的归档或删除顺序。

### R0.3 Rust workspace 门禁

```bash
cd sim-rs
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

完成条件：

1. workspace 可独立构建与测试；
2. 正式执行路径不需要 Go 二进制或动态库；
3. 没有 silent fallback；
4. run manifest 能明确证明实际执行者是 Rust；
5. 证据记录 git SHA、profile/rules/fixture hash 与 hard gates。

## R1 — Rust-native Hero client/runtime（下一原子阶段）

固定实现顺序：

1. Hero auth/config 与协议 DTO；
2. WebSocket tick/state/received 事件流；
3. HTTP submit、receipt 与稳定幂等键；
4. DTO → 唯一 Rust `TickState` 归一化；
5. shadow tenant loop；
6. planning 前按 Tick exactly-once；
7. single-writer lock、live 双确认、deadline 与错误即停；
8. run-scoped manifest/runtime/decision JSONL；
9. reconnect/idle watchdog、Ctrl+C/timeout 清理；
10. t3/t4 100 Tick shadow。

R1 完成前不得推进复杂战斗、LLM、部署平台或生产租户切换。

## 已验证但需迁移的历史知识

以下来自旧 Go/Fusion 实测，可作为 Rust fixture/验收，不作为运行依赖：

- 重连可能重放同一 Tick，去重必须发生在 planning/telemetry 前；
- `command accepted` 不代表动作已结算，必须观察下一状态 delta；
- 满仓、满载 Worker 占 Core 会形成 spawn/deposit 永久死锁；
- 服务器可能静默 30–90 秒后恢复，不能用缓冲日志误判挂死；
- single-writer、幂等键、fatal submit rejection、正常退出与锁释放是 live P0；
- 真实 t3/t4 资源极稀缺，探索占主导，资源记忆与 blacklist 优先于复杂战斗。

## 下一次回执模板

```text
line: PURE_RUST
branch:
head:
current task:
touched files:
tests/evidence:
uncommitted WIP:
legacy Go/FFI dependency: none | ...
conflicts with Race v2: none | ...
next atomic task:
```
