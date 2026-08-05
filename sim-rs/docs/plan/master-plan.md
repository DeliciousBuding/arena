# Rust 覆写线完整执行计划（master-plan）

> 分析线出品（rust-rewrite worktree）。执行线（rust-sim）按此计划推进。
> 事实基线：rust-sim@e6bd3d6（51 tests 全绿、单核 12.1x、6 CLI 产物已落盘未提交）。
> 最后更新：2026-08-05。

## 0. 目标与范围

**目标**：模拟器平台线（domain + sim + strategy + 6 CLI）Rust 全对偶，差分门禁证明语义与 Go oracle 一致，性能对决完结，全部产物落位收口。

**范围边界**：
- ✅ 范围内：`internal/domain`、`internal/sim`、`internal/strategy`、`cmd/sim{run,search,optsearch,paramscan,golden,debug}` 的 Rust 对偶 + 差分验证 + 基准
- ❌ 范围外（不扩）：`agent`/`llm`/`mapstore`/`contracts` wire/`hero`/`ops`/`obs`/`telemetry`/`cmd/arena` 服务器运行线——无 oracle 可对、无性能诉求，转 Rust 负价值

**产出物**：6 CLI 二进制、差分脚本、golden.json（Rust 版）、基准数字文档、PARITY/MASTER 收口。

## 1. 现状基线（已完成，不再重做）

| 提交 | 内容 | 验证 |
|---|---|---|
| 88a9af5 → dc7a0c6 | domain/engine/strategy 全移植 + stamped BFS | 43 tests 绿、单核 12.1x（51.5ms vs 563-662ms） |
| e6bd3d6 | cli 共享库（contracts/batch/policy_name/rng）+ simrun | 51 tests 绿、真实场景跑通 |
| 未提交 | simsearch/paramscan/optsearch/simgolden/simdebug（执行线产物） | PROGRESS.md 记录，待复核 |

## 2. 阶段与任务（执行顺序 = 阶段序）

### Phase 1：执行线产物复核与提交（Batch 2）

| ID | 任务 | 验收命令（全过 = 完成） |
|---|---|---|
| P1.1 | 复核 5 个 CLI 产物：读 `sim-rs/PROGRESS.md` 回执 + 逐个 bin 检查与 Go 源码对偶 | 与 Go cmd/*.go 逐行语义核对，无偷改核心 crate |
| P1.2 | 清 clippy warnings（e6bd3d6 残留 4 个） | `cargo clippy` 0 warning |
| P1.3 | 全仓质量门禁 | `cargo test` 全绿（≥51+新增）、`cargo fmt --check` 干净 |
| P1.4 | 6 CLI 确定性验收 | simsearch/optsearch 同 seed 双跑 `diff` 为空 |
| P1.5 | 提交 Batch 2 | 提交信息含验收证据 |

### Phase 2：差分门禁（E，核心验收，Batch 3 前半）

| ID | 任务 | 验收命令（全过 = 完成） |
|---|---|---|
| P2.1 | paramscan 确定性对比：Go vs Rust 输出逐字节 diff（paramscan 无随机，**必须完全一致**） | `diff <(go run ./cmd/paramscan) <(./sim-rs/target/release/paramscan.exe)` 为空 |
| P2.2 | simrun 同场景对比：3 场景 × 默认策略，Go vs Rust 摘要输出 diff | 同 P2.1 模式，diff 为空 |
| P2.3 | golden 核验：Rust `simgolden --update` 后与 Go 版原 golden.json 数值对比，容差内（deposits/spawns 25%、workers 20%、kills 50%、unitsLost 硬限+1） | 容差内 PASS；超差记录差异数字不硬改 |
| P2.4 | 差分脚本反向验证：人为改一处引擎输出，确认脚本会 FAIL | 制造失败 → 脚本 exit 1 |

### Phase 3：性能对决完结（I，Batch 3 后半）

| ID | 任务 | 验收 |
|---|---|---|
| P3.1 | rayon batch 多核基准：2 万评估 × 500 tick | 数字落文档，目标 <5min（Go 28 核 24.7min） |
| P3.2 | 单核复测（bench_tests 同构） | ≥10x 保持 |
| P3.3 | 双核/全核扩展曲线 | 数字落文档 |

### Phase 4：加固（G/H，P1，Batch 4）

| ID | 任务 | 验收 |
|---|---|---|
| P4.1 | 引擎事件级差分：Event 序列（含 values）与 Go 逐事件对齐 | 对齐报告；差异登记 PARITY |
| P4.2 | CLI 输出格式测试固化：simgolden 容差逻辑 + simrun 格式单测进 cargo test | cargo test 全绿 |

### Phase 5：收尾（F/J，Batch 5）

| ID | 任务 | 验收 |
|---|---|---|
| P5.1 | PARITY.md 复核（§7 场景格式、§8 RNG、新增差异全登记） | 文档更新 |
| P5.2 | rust-sim MASTER.md 收口（执行线进度 SSOT） | 文档更新 |
| P5.3 | 删 Go oracle（**用户裁决后**，keep_oracle 契约：差分全绿后） | 用户指令 |
| P5.4 | 基准/性能/差分数字全部落位 docs | 文档完整 |

## 3. 并行编排

```text
Phase 1（串行复核提交）
   └→ Phase 2：P2.1/P2.2/P2.3 可三路并行（无文件重叠），P2.4 依赖其一
        └→ Phase 3（依赖 Phase 2 通过）
             └→ Phase 4：P4.1/P4.2 并行
                  └→ Phase 5（串行，P5.3 等用户裁决）
```

- 共享写入点：`runtime/golden.json` 唯一归属 P2.3；Cargo.lock 已锁定（任务 A）
- 差分脚本归属 P2.1-P2.4 同一执行者（一个脚本演进）

## 4. 里程碑

| 里程碑 | 判定 | 预计 |
|---|---|---|
| M2：6 CLI 全对偶 | Phase 1 全过 | 半天 |
| M3：差分门禁绿 | Phase 2 全过（含反向验证） | 半天 |
| M4：性能对决完结 | Phase 3 数字落文档 | 半天 |
| M5：收口 | Phase 5 全过 | 半天 |

合计：**约 1.5-2 个工作日**（单人；若 Phase 2 三路并行执行者，可压到 1 天）。

## 5. 决策点（需用户拍板）

| # | 决策 | 默认建议 |
|---|---|---|
| D1 | 删 Go oracle（P5.3） | 差分全绿后再删（keep_oracle 契约，用户已表态方向） |
| D2 | 执行线 e6bd3d6 提交去留 | 保留（已是事实基线，无副作用） |
| D3 | 执行者安排 | 执行线 owner（rust-sim）按此计划推进 |

## 6. 风险与止损

- **R1 语义漂移**：P2.1/P2.2 必须逐字节一致，否则引擎/策略有真实 bug——修实现不修脚本（差分脚本是法的载体）
- **R4 golden 超差**：记录差异数字 + 定位根因（引擎 bug vs 预期语义差），不硬改容差
- **三道止损**：数字对不上立即停；同一验收连败 3 次换项；结果比基线差回滚
- **防作弊**：不许改核心三 crate 和共享库；不许 `.skip`/放宽测试；不许为过 check 改 golden/容差；测试数 ≥ 基线
