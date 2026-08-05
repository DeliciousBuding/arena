# rust-sim 重写线执行状态

> rust 重写线唯一进度 SSOT（rust-sim worktree 内部，与主仓库 `docs/progress/MASTER.md` 隔离，不合并回主线）。
> 最后更新：2026-08-05。代码、测试、基准数字优先于聊天记录。

## 目标

在 `rust-sim` 分支（从 go-rewrite fork）用 Rust 完整重写模拟器平台：domain + engine + strategy + cli（simrun/simsearch/optsearch/paramscan/simgolden/simdebug 对偶），语义对齐 Go oracle（差分门禁），性能碾压 Go（stamped BFS 已 12x）。

## 已完成

### 核心三 crate（全部编译通过、测试全绿、clippy 0 warning、fmt 干净）

| crate | 内容 | 测试 |
|---|---|---|
| `domain` | 模型（BTree 确定性集合）+ 导航（**stamped grid BFS**：网格世代戳 visited，无哈希无分配） | 8 |
| `engine` | 结算 8 子系统：movement/economy/combat/heal/spawn/refill/vision/enemy_attack | 22 |
| `strategy` | planner（decide 闭环/巡逻/螺旋覆盖/战斗意图/停滞跳出）+ economic + commander | 13 |
| 闭环集成 | commander → planner → engine 全链路（经济循环/harvest/deposit/spawn/cargo 清零/确定性） | 4 |

**总计 47 tests 全绿**（`cargo test`），clippy 0、fmt 干净。

### 性能（同机实测，release 模式，与 Go go-rewrite@b72ff3c 同场景对比）

| 指标 | Go | Rust 同构 | Rust + stamped BFS | vs Go |
|---|---|---|---|---|
| 100 ticks | 9.4-11.5ms | 6.6ms | 3.2ms | 3.0x |
| 1000 ticks | 563-662ms | 178ms | **51.5ms** | **12.1x** |

### 文档

- `sim-rs/README.md`：平台分层与路线图
- `sim-rs/PARITY.md`：与 Go oracle 的有意差异登记（BTree 确定性、闭枚举、settle_in_place API、PascalCase 场景 JSON）

## 剩余任务（一次性完成线）

| # | 任务 | 状态 | 依赖 |
|---|---|---|---|
| A | cli crate 共享库（contracts/batch/policy_name）+ simrun | 待做 | — |
| B | simsearch + paramscan | 待做 | A |
| C | optsearch（SA + GA 三场景评分） | 待做 | A |
| D | simgolden + simdebug | 待做 | A |
| E | 差分门禁（Go oracle vs Rust 同命令输出对比）+ golden 全绿 + 集成验收 | 待做 | B/C/D |
| F | 收尾：全量测试 + 基准复测 + PARITY 更新 + MASTER 收口 | 待做 | E |

## 关键契约（任务书事实基础，均已实测确认）

1. **场景 JSON**（`runtime/scenes/*.json`）：PascalCase 字段（`"Tick"/"Status"/"Resources"/"Core"/"Units"/"ResourceCells"` 数组/`"Beacon"`），Go 因 case-insensitive 解析掩盖；**Rust serde 必须 `rename_all = "PascalCase"` + 全字段 `#[serde(default)]`**（OwnerUsername/Vanguards/Rangers/PopulationTier 等经常缺失）。
2. **golden.json**：`{ticks, policies, scenes: [{scene, deposits, spawns, workers, kills, unitsLost, blocked, moves, resources}]}`（camelCase 标签，Go goldenSnapshot 定义）。
3. **policy 名**（Batch 结果排序键）：`Name` 字段或确定性拼接 `wt%d_r%d_er%d_pc%d_m%d`；Batch 结果按 scene 名升序 × policy 名升序。
4. **Batch 语义**：全组合并行，Timeline 每 25 tick 采样（Tick/Resources/ResourceCells/Workers/Deposits 累计/Kills/UnitsLost/Mode）。
5. **评分公式**（optsearch）：`spawns×3 + deposits×5 + harvests×2 + workers×10`，三场景（base/dense/sparse 各自 latent 池）取最低分。
6. **simsearch 随机生成**：Go math/rand 序列与 Rust 不可共用——Rust 用自研确定性 RNG（SplitMix64），PARITY 记录"仅 Rust 内部确定性"。
7. **simgolden 容差**：deposits/spawns 25%、workers 20%、kills 50%、blockedRatio 30%、unitsLost 硬限 +1。
8. **Go 输出为 stdout 表格**（无 records.jsonl）——差分 = 同场景同 seed 下 Go/Rust 命令输出逐字节对比。
