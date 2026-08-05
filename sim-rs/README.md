# Arena Simulator Rust（sim-rs）

Rust 版 Arena 模拟器平台。从 `go-rewrite` 分支的 Go 模拟器（`internal/sim` +
`internal/strategy` + `cmd/sim*`）整体移植，**语义对齐 Go 版（oracle），
输出契约（scenario/records/summary/manifest 格式）与 Go 版逐字节可比**。

## 分层（模块化设计）

```text
crates/domain     纯模型 + 导航（无引擎/策略依赖；serde JSON 契约对齐）
crates/engine     结算引擎（8 个子系统：movement/economy/combat/heal/spawn/refill/vision/enemy_attack）
crates/strategy   决策层（planner/commander/economic/combat tactics）[移植中]
crates/cli        simrun/simsearch/optsearch/paramscan/simgolden 等价命令 [移植中]
```

依赖方向单向：cli → strategy → engine → domain。engine 不依赖 strategy
（可独立嵌入）；domain 不依赖任何 crate。

## 对齐契约（与 Go 版逐字节可比）

| 维度 | 契约 |
|---|---|
| 输入 | scenario JSON / 初始 TickState（字段名与 Go `domain` 一致） |
| 输出 | records.jsonl / final-world.json / summary.json / manifest.json（Go 格式） |
| 门禁 | 差分 runner：同场景 Go oracle vs Rust 输出逐字节 diff；golden.json 回归集全绿 |
| 确定性 | 同输入同输出；集合/映射确定性迭代（BTree 结构，见 PARITY.md） |

## 已知有意差异

见 `PARITY.md`（唯一记录，任何与 Go 版行为差异必须登记）。

## 命令（骨架阶段）

```bash
cargo build -p arena-sim-engine
cargo test -p arena-sim-domain -p arena-sim-engine
cargo fmt --check && cargo clippy -- -D warnings
```

## 路线图

1. **P0 对齐**：strategy 移植 + CLI 移植 + 差分门禁 + golden 全绿（当前）
2. **P1 性能**：网格 stamped BFS（替换 HashSet visited，Go 版 54% 热点根源）、
   每 tick 缓冲池（事件/BFS 队列复用）、rayon 批量评估
3. **P2 平台化**：库 API（scenario 解析/评估器可嵌入）、策略变体注册机制、
   参数扫描/赛马工具对偶（Go 的 optsearch/simsearch 等价能力）
4. **P3 扩展**：RL 环境 API（step/reset）——仅当真实需求出现
