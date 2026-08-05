# Arena Pure Rust Agent 协作说明

最后更新：2026-08-06 02:45（UTC+8）。

## 🚨 当前总控：每次开始任务、上下文压缩或提交前必须重读

架构裁决已经收敛：

- **Pure Rust 是 Arena 唯一长期产品主线**；
- TS 暂时承担 t1/t2 当前生产、calibration、策略实验、迁移 Oracle 与回滚；
- Pure Go、Go Host + Rust Kernel、FFI、DLL/SO 与 Go fallback 全部冻结。

权威入口：

- 跨线迁移总控：GitHub Issue **#27**
- Pure Rust 实现总控：GitHub Issue **#26**
- Pure Rust 架构与共享契约：Draft PR **#31**
- Rust 当前进度：`sim-rs/PROGRESS.md`
- Rust 计划：`sim-rs/docs/plan/`

**Pure Rust Agent 当前必须执行：**

1. 立即停止继续修 Go、FFI、Fusion CI 或 Go planner；
2. 将当前本地 Pure Rust 方案/WIP 压成一个原子提交并推送 `rust-rewrite`；
3. 在 Issue #27 回执实际 branch/head/touched files/tests/uncommitted WIP；
4. 列出所有残余 Go host / FFI / Go fallback 依赖；
5. 下一原子任务直接做 Rust-native Hero client/runtime 纵切；
6. 后续顺序固定：协议纵切 → exactly-once runtime → validator fail-closed → World/资源记忆 → 探索记忆/blacklist → 路径预约 → 威胁记忆 → Core 防御/战斗 → replay/simulator/search。

GitHub Issue 评论是持久总控，但不会自动打断已运行的本地 Agent。因此本文件与根目录 `CLAUDE.md` 是仓内强制广播入口；Agent 必须主动检查 #27/#26，不能等待聊天提醒。

## 目标架构

Pure Rust 直接拥有完整产品闭环：

```text
Hero HTTP / WebSocket
→ protocol decode + normalized TickState
→ World memory / PlanningSnapshot
→ deterministic planner + validator
→ exactly-once submit / idempotency / single-writer lock
→ telemetry / replay / simulator / optimizer
```

明确禁止：

- Go Host；
- Rust cdylib / DLL / SO planner；
- FFI ABI 或双数据模型；
- Rust 失败后静默切回 Go/TS；
- 为旧 Go 结构再实现第三套 planner/runtime；
- LLM 进入每 Tick 热路径或直接 submit。

旧 Go/Fusion 代码只作为知识来源：协议观测、幂等键、锁语义、reconnect 故障、telemetry 字段与 fixture。提取完成后归档或删除，不成为运行依赖。

## 文件地界

允许修改：

- `sim-rs/**`
- Pure Rust protocol/client/runtime/domain/world/strategy/simulator/CLI
- t3/t4 shadow 与 bounded-live 证据
- Rust 实现计划与进度

禁止修改：

- `packages/arena-agent/**`
- `packages/arena-hero-ts/**`
- t1/t2 live、ArenaWatchdog 与 TS runtime 配置
- `docs/race/**`、`contracts/race/**`（除非 Issue #27 明确分配）
- 根目录 Go runtime/FFI 的新功能

## Rust 标准门禁

```bash
cd sim-rs
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

若 Pure Rust workspace 根目录迁移，命令路径可调整，但必须保留同等门禁。

正式证据必须记录：

- git SHA；
- profile ID/hash；
- rules/fixture/scenario hash；
- seed 与 tick 数；
- hard gate 计数；
- run manifest / JSONL / replay 路径；
- 是否仍存在 Go/FFI 运行依赖。

## P0 红线

- 同租户只能一个 live writer；
- live 必须双确认并先取得 single-writer lock；
- 重连后 exactly-once，不重复 decide/submit；
- 使用跨进程稳定幂等键；
- stale/duplicate/late tick 必须拒绝；
- deterministic invalid 或 repair 立即终止当前 run；
- panic 必须记录并非零退出；
- Ctrl+C/timeout 后进程树与锁全部释放；
- 不把 `INCONCLUSIVE` 写成 `MATCH`；
- 不把 micro-Golden 写成 Runtime-Golden；
- secret 不得进入日志、fixture、manifest 或文档；
- t3/t4 只用于 Rust shadow/bounded live，未晋级不得碰 t1/t2。

## Agent 回执模板

在开始下一原子任务前，到 Issue #27 留言：

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

不以聊天摘要代替 commit、测试和证据路径。
