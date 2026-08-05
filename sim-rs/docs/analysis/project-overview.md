# 项目全景与覆写方向（rust-rewrite 分析线）

> 分析线 SSOT（rust-rewrite worktree 内部，与执行线 rust-sim 隔离）。
> 本分析基于 rust-sim@e6bd3d6 干净快照 + Go go-rewrite 源码逐行调研。
> 最后更新：2026-08-05。

## 1. 项目是什么

Arena：LLM 驱动的实时策略游戏模拟器平台。go-rewrite 分支（Go 版）是模拟器平台化的实现：`internal/domain`（领域模型）+ `internal/sim`（结算引擎）+ `internal/strategy`（策略）+ 6 个 CLI（simrun/simsearch/optsearch/paramscan/simgolden/simdebug）。rust-rewrite 目标是**彻底 Rust 覆写**该平台，语义对齐 Go oracle，性能碾压 Go。

## 2. 覆写方向（Phase 0 意图）

TS-only 主线的模拟器性能与确定性不满足需求（Go 版 GC 瓶颈、map 迭代序漂移）。Rust 覆写线目标：
- **性能**：单核 ≥10x（已实测 12.1x）、多核线性扩展（rayon batch，未实测）
- **确定性**：BTree 结构消灭 map 迭代序漂移（Go 版 refill 评分曾因此不稳）
- **平台化**：engine 不依赖 strategy 可独立嵌入；6 CLI 对偶 Go 命令
- **语义对齐**：差分门禁保证与 Go oracle 行为一致（容差内）

## 3. 当前基线（e6bd3d6，实测）

| 层 | 内容 | 测试数 |
|---|---|---|
| domain | 模型 + stamped grid BFS 导航 | 8 |
| engine | 8 结算子系统（movement/economy/combat/heal/spawn/refill/vision/enemy_attack） | 22 |
| strategy | planner + economic + commander + 闭环集成 | 17 |
| cli 共享库 | contracts/batch/policy_name/rng（rayon 并发） | 4 |
| simrun | 独立模拟器 CLI（真实场景实测跑通） | — |

**51 tests 全绿**，clippy 0、fmt 干净。性能：1000 ticks 51.5ms vs Go 563-662ms（12.1x，release 同机）。

## 4. 与执行线（rust-sim）的关系

rust-rewrite 从 rust-sim@e6bd3d6 fork。执行线后续产物（simsearch/paramscan/optsearch/simgolden/simdebug 六文件 + golden.json 更新，未提交）不属于本分析快照；本分析以 e6bd3d6 为事实基线，涉及执行线状态处显式标注（待执行线提交后复核）。

## 5. 调研方法论

- Go 源码逐行读：6 个 cmd（simrun 237 / simsearch 246 / paramscan 105 / simdebug 111 / simgolden 268 / optsearch 479 行）+ internal/sim/batch.go + internal/strategy 三文件 + internal/domain
- 实测验证：场景 JSON 格式（PascalCase 坑）、golden.json 结构、runtime/scenes 三场景真实存在
- 基准对比：同机同场景 Go vs Rust release，数据见 PARITY/MASTER
