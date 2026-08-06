# Pure Rust 主线里程碑

## M0 — Rust 模拟与策略地基 ✅

- `domain` / `engine` / `strategy` / `cli` 已存在；
- base/dense/sparse 模拟经济闭环可运行；
- 单核性能相对旧 Go oracle 曾测得约 12.1x；
- replay、golden、search/optimize 方法已有基础。

该里程碑只证明研究地基，不证明生产运行能力。

## M1 — 去 Fusion 与单一 SSOT

- Fusion/FFI 历史归档；
- 当前计划、进度、AGENTS 全部指向 Pure Rust；
- `crates/ffi` 依赖与调用者完成盘点；
- Rust Agent 回执实际 WIP 与测试；
- workspace fmt/clippy/test 有可复现绿色基线。

判定：任何新 Agent 不会再把 Go Host + Rust Kernel 当成终态。

## M2 — Rust-native Hero Shadow

- Rust 直接实现 HTTP/WS、auth、wire DTO 和 normalization；
- run-scoped manifest/runtime/decision JSONL；
- t3/t4 至少 100 唯一 Tick shadow；
- 断流重连无重复 decide；
- 0 submit、0 panic、0 protocol mismatch。

判定：无需 Go/FFI 即可读取真实服务器并持续决策。

## M3 — Exactly-once Runtime 与安全门禁

- single-writer lock；
- live 双确认；
- stable idempotency key；
- duplicate/stale/late Tick 在 planning 前拒绝；
- invalid/repair、submit rejection、panic 均 fatal；
- SIGINT/timeout 正常释放锁和任务；
- settlement delta 可观测。

判定：全部故障注入 hard gates 为 0。

## M4 — 经济闭环与导航

- ResourceMemory、唯一分配、sticky task；
- harvest/return/deposit；
- 满仓让位和 spawn/deposit 破锁；
- move reservation、长墙/窄口绕行；
- respawn 恢复和 dropped cargo；
- economy 场景 paired-seed 证据。

判定：t3/t4 真实状态出现可解释经济 delta，不能只看 accepted。

## M5 — 探索、威胁与 Core 生存

- chunk/frontier/blacklist；
- enemy memory 与 stationary/active；
- ETA/threat score；
- Core 多轴防御、恢复与守卫；
- crossfire/aggressive 场景尾部不低于 TS 基线。

## M6 — 战斗与离线优化

- 预测攻击格、包抄、堵路、撤退和有限 raid；
- StrategyProfile/RaceResult；
- Runtime-Golden/replay/simulator 对齐；
- search/optimizer 输出 candidate，不绕过晋级门禁。

## M7 — t3/t4 生产级 Canary

```text
24h/10,000 Tick shadow
→ 3/10/30/100 Tick bounded live
→ 1,000 Tick Canary
→ 10,000 Tick soak
```

判定：hard gates 全 0，净经济和稳定性相对固定 TS/profile 基线非劣或更优。

## M8 — TS → Rust 生产迁移

- 只切一个 t1/t2；
- 另一租户保持 TS 对照；
- Rust 长期 Canary 成功；
- TS 回滚演练通过；
- 再切第二租户；
- Go/Fusion 归档，TS 收敛为策略实验、Oracle 与回滚线。
