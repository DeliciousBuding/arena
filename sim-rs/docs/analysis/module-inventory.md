# 模块清单与 S.U.P.E.R 评估（rust-rewrite 分析线）

> 评估对象：rust-sim@e6bd3d6 快照的 Rust 实现 + 其 Go 对偶（规格源）。
> S.U.P.E.R 评分：S=简洁/可读、U=唯一职责、P=性能、E=可扩展、R=可复用。5 分制。

## 1. Rust 侧模块清单（当前快照）

| 模块 | 职责 | 公共 API | S.U.P.E.R | 备注 |
|---|---|---|---|---|
| `domain/lib.rs` | 领域模型（Position/UnitType/TickState/Plan 等） | 全模型 + 常量 + 集合类型 | 5/4/4/4/5 | 闭枚举；BTreeSet 确定性；serde 标签 UPPERCASE 已备 |
| `domain/nav.rs` | 有界 BFS 导航（BfsSearcher） | first_step / margins / MAX_VISITED_NODES | 4/5/5/4/5 | stamped 世代戳 visited，节点成本 ~5ns |
| `engine`（8 子系统） | 结算：movement/economy/combat/heal/spawn/refill/vision/enemy_attack | Engine::settle / settle_in_place + SettleStats | 4/4/5/4/4 | settle_in_place 原地结算免克隆（PARITY §3）；不依赖 strategy |
| `strategy` | planner（decide 闭环）+ economic + commander | Planner::decide / Config / DirectiveMode | 4/4/4/4/4 | 每实例独立可并发；bfs+障碍缓存每 tick 刷新 |
| `cli/lib.rs` 共享库 | contracts（scene/policy/golden JSON）+ batch（rayon）+ policy_name + rng | load_scenes/load_policies/batch/Scenario/BatchResult/SplitMix64 | 4/5/5/4/5 | 接缝冻结：6 CLI 的公共地基 |
| `cli/bin/simrun.rs` | 独立模拟器 CLI（场景 JSON → 批量评估 → 摘要/赛马表） | 二进制 | 4/4/4/4/3 | 输出格式与 Go printSummary/printRace 逐字节对齐 |

## 2. Go 对偶规格清单（移植事实源，逐行读完）

| Go 源 | 行数 | Rust 对偶 | 状态 |
|---|---|---|---|
| cmd/simrun/main.go | 237 | cli/bin/simrun.rs | ✅ 已实现 |
| cmd/simsearch/main.go | 246 | cli/bin/simsearch.rs | 执行线产物（未提交） |
| cmd/paramscan/main.go | 105 | cli/bin/paramscan.rs | 执行线产物（未提交） |
| cmd/optsearch/main.go | 479 | cli/bin/optsearch.rs | 执行线产物（未提交） |
| cmd/simgolden/main.go | 268 | cli/bin/simgolden.rs | 执行线产物（未提交） |
| cmd/simdebug/main.go | 111 | cli/bin/simdebug.rs | 执行线产物（未提交） |
| internal/sim/batch.go | — | cli/lib batch.rs | ✅ 已实现 |
| internal/strategy/* | ~1200 | strategy crate | ✅ 已实现 |

## 3. S.U.P.E.R 架构健康总结

**亮点（保留）**：
- 单向依赖：cli → strategy → engine → domain，engine 可独立嵌入（P2 平台化目标的根）
- 确定性优先：BTreeMap/BTreeSet 全替换 Go map，消灭迭代序漂移类 bug（P2 已验收）
- 性能分层：stamped BFS（单核 12.1x）+ rayon batch（多核，待执行线实测）+ LTO/codegen-units=1

**短板（改进优先级）**：
1. **测试缺口**：engine 22 tests 偏少（Go 版 engine 测试更多）；combat/heal/enemy_attack 子系统缺逐事件断言（P1）
2. **CLI 输出测试**：6 个 CLI 的输出格式只有 simrun 有实测验证；simgolden 容差逻辑应有黄金对比测试（P1）
3. **事件流对齐**：engine 事件（Event）序列与 Go 的逐事件对齐未做差分（仅 stats 对齐）——差分门禁应升级到事件级（P2）
4. **文档时效**：PARITY.md 需在执行线提交后复核（P2）

## 4. 平台化设计评估（P2 目标）

- engine 不依赖 strategy：✅ 已满足（engine crate 无 strategy 依赖）
- 6 CLI 共享地基：✅ contracts/batch/policy_name/rng 已就位，接缝冻结
- 场景格式兼容：✅ PascalCase 解析 + default 补齐（PARITY §7 登记 Go 的 case-insensitive 坑）
- 未来嵌入（MapStore worker/RL 训练）：engine 的 settle_in_place + 无状态结算已具备嵌入形态，无需预留接口（按用户规则不提前实现）
