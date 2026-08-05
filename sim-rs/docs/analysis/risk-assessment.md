# 风险评估与缓解（rust-rewrite 分析线）

## 1. 风险矩阵

| # | 风险 | 等级 | 描述 | 缓解 | 验证证据 |
|---|---|---|---|---|---|
| R1 | 引擎语义漂移（Rust 与 Go 行为不一致） | **高** | 结算顺序/边界条件差异 → 策略评分错 | 差分门禁：同场景同 seed 下 Go/Rust 命令输出逐字节 diff；事件级对齐（P2 升级） | 51 tests 全绿 + 基准同构场景 12.1x 同经济曲线 |
| R2 | 契约格式坑（场景 JSON PascalCase） | 高 | Go case-insensitive 解析掩盖大小写；serde 默认 case-sensitive 会解析失败 | rename_all=PascalCase + 全字段 default；测试覆盖 parse_pascal_case_scene_file | ✅ 已识别并修复，PARITY §7 |
| R3 | 随机序列不可复现（simsearch/optsearch） | 中 | Go math/rand 序列无法在 Rust 复刻 | SplitMix64 自研确定性 RNG，同 seed 双跑 diff 为空（验收硬指标） | PARITY §8；执行线已实现双跑 diff 验证 |
| R4 | golden 数值差异（真实语义差异 vs 实现 bug 难分） | 中 | 引擎微调导致 deposits 漂移 | 容差常量（deposits/spawns 25%、workers 20%、kills 50%、unitsLost 硬限 +1）；差异数字记录不硬改 | runtime/golden.json 基准（Go 版产出） |
| R5 | 多核扩展性未实测 | 中 | rayon batch 理论线性，未跑 2 万评估对比 | 任务 E 差分阶段附基准：Go 28 核 24.7min vs Rust batch | Go 侧基线已有（24.7min） |
| R6 | 执行线产物完整性（子代理 6 CLI） | 中 | 产物未提交、未复核 | 执行线收尾任务：提交后复核 clippy/test/验收命令 | PROGRESS.md（执行线） |
| R7 | 性能回归（后续优化破坏确定性） | 低 | 优化引入非确定性 | 双跑 diff 进 CI；stamped BFS 已锁定世代戳算法 | bench_tests 同构基准 |

## 2. 三道止损（执行线验收用）

1. **任务 0 前提核验**：数字对不上（场景解析失败/测试基线下降）立即停
2. **同一验收连败 3 次换项**：不一条道走到黑
3. **结果比基线差回滚**：回滚如实报告，"没做成但说清了"合格，"做了但更糟"不合格

## 3. 防作弊清单（执行线任务书已含）

- 不许改核心三 crate 与共享库（接缝冻结）
- 不许跳过/放宽测试、不许 `.skip`
- 不许为过 --check 改 golden.json 或容差常量
- simsearch 不许读文件（纯生成式，与 Go 一致）
- 测试数 ≥ 基线（51）、skipped 0

## 4. 反向验证（静默事故防护）

- 确定性断言：同 seed 双跑 diff（执行线已实测通过）
- 假绿灯防护：验收命令含实际运行（非 echo 占位）；simgolden --check 必须真实比对
- 坏信号防护：unitsLost 硬限 +1 是"死循环/战斗回归"的强信号，超过必 FAIL

## 5. S.U.P.E.R 健康摘要

- 健康度：**高**。无循环依赖、无共享可变状态、性能优化已分层锁定
- 优先整改：engine 事件级测试（R1 缓解）、CLI 输出格式测试（R2 缓解）
- 无结构性债务：BTree 确定性 + stamped BFS 是终点设计，非过渡方案
