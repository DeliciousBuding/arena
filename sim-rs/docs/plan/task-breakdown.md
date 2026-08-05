# 任务分解（rust-rewrite 分析线，LOCAL_ONLY 模式）

> 执行线任务已部分展开（A 完成、B/C/D 子代理产物已落盘未提交）；本表是**规划视图**，
> 供执行线收尾与复核使用。优先级 P0=必须/P1=应该/P2=可选。

## 任务总表

| ID | 任务 | 优先级 | 工作量 | 依赖 | 验收条件 | 状态 |
|---|---|---|---|---|---|---|
| A | cli 共享库（contracts/batch/policy_name/rng）+ simrun | P0 | M | — | 51 tests 全绿；simrun 真实场景实测 | ✅ e6bd3d6 |
| B | simsearch + paramscan | P0 | M | A | 同 seed 双跑 diff 为空；输出含 search:/summary: 行 | 执行线产物（未提交） |
| C | optsearch（SA+GA 三场景评分） | P0 | L | A | 双跑 diff 为空；SA/GA 输出格式对 Go | 执行线产物（未提交） |
| D | simgolden + simdebug | P0 | M | A | --update/--check 流程通；dump 格式对 Go | 执行线产物（未提交） |
| E | 差分门禁（Go oracle vs Rust 同命令输出 + golden 数值核验） | P0 | M | B/C/D | Go/Rust 同场景输出 diff；golden 容差核验 | 待做 |
| F | 收尾：全量测试 + 基准复测（含 rayon 多核）+ PARITY 复核 + MASTER 收口 | P0 | S | E | 全绿；基准数字落文档；PARITY 复核 | 待做 |
| G | 引擎事件级差分（R1 缓解升级） | P1 | M | E | 事件流（Event 序列）与 Go 逐事件对齐 | 待做 |
| H | CLI 输出格式测试固化（simgolden 容差逻辑单测） | P1 | S | D | 输出格式测试进 cargo test | 待做 |
| I | rayon batch 多核基准（2 万评估 vs Go 24.7min） | P1 | S | F | 数字落文档，目标 <5min | 待做 |
| J | 删除 Go oracle（差分全绿后） | P2 | S | E+F | 用户裁决后执行 | 待做 |

## 测试要求（默认，除非显式 N/A）

- A/B/C/D：每个 CLI ≥ 4 个测试（确定性/格式/边界），并入 cargo test
- E：差分脚本本身要能"人为制造失败"验证会响（反向验证）
- F：基准复测命令与 bench_tests 同构（release、同场景）
- 文档任务（PARITY/MASTER）：N/A（文档即产物）

## 治理要求

- B/C/D 完成后：PARITY.md 复核（§7 场景格式、§8 RNG 差异）+ MASTER.md 更新
- 任何"有意差异"必须登记 PARITY，禁止静默
