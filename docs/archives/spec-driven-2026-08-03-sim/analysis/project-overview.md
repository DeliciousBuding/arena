# 分析：Arena 本地经济模拟器（Digital Twin MVP）

最后更新：2026-08-03（spec-driven Phase 1 历史规划快照）

> 本文记录规划生成时的仓库与运行现场，不是当前进度 SSOT。当前状态以
> `docs/progress/MASTER.md`、运行 manifest 和 JSONL 遥测为准。

## 背景与目标

规划生成时 W4 正在收口（t1 deterministic live burn-in），GPT 正在优化确定性 planner 策略。
**痛点：验证周期 = 15s/tick × 短窗口（33~100 tick）≈ 8~25 分钟/轮，噪声大 → 盲调多、推进慢。**

目标：本地光速模拟（1000× 加速），让策略验证从"25 分钟/轮"降到"秒级/轮"。
本期范围：**经济模拟器 MVP**（movement / economy / vision，无对手、无 combat）。

## 现状盘点

| 已有（可复用） | 缺（本次实现） |
|---|---|
| `arena-hero-ts` types：PlayerState / UnitView / CommandPlan | tick 推进的状态转换函数（结算引擎）——完全为零 |
| `turn.ts` 动作构建 / plan 编码（与上游逐字节兼容） | `rules.ts` 仅 12 行（一个 capacity 函数） |
| `domain/`：model / nav（BFS 绕障寻路）/ plan-validator / world（视野记忆） | sim/ 目录、快照载入、校准工具 |
| `planning/`：deterministic-planner / worker-task-planner（纯净：快照进 plan 出） | 视野遮蔽实现、refill 随机源 |
| `strategies/`：safety-planner | benchmark 输出（tick 吞吐/经济曲线） |
| `fixtures/differential/burnin-20260802-a/`：数百真实 tick 序列 | — |
| `docs/game-rules.md`：778 行规则契约（v0.11，含结算顺序） | — |

## 核心架构：模拟器 = 一台"假的线上服务器"

```text
真实服务器 ──> PlayerState ──┐
                              ├──> 策略（planning/strategies 零改动）──> CommandPlan ──> 提交/丢弃
本地模拟器 ──> PlayerState ──┘                                              │
                                                            模拟结算引擎 (world, plans) → nextWorld
```

策略层永远只看到 PlayerState（与线上同构）→ 线上代码 = 模拟代码，sim-to-real gap 最小化。

## 隔离约束（用户核心要求：不污染真实操作）

| # | 边界 | 实现 |
|---|---|---|
| 1 | 进程隔离 | sim 独立 CLI 进程，与 tenant-runtime 零共享 |
| 2 | **提交通道隔离** | sim 目录禁 import `client.ts` / SDK client（脚本强制检查）；不加载 `.env`；submitter = 本地结算引擎 |
| 3 | 锁/端口隔离 | 不碰 single-writer-lock；不占 8123-8126 |
| 4 | 数据隔离 | 只读 fixtures/ 与 mapstore（快照导入）；写入 `runs/sim-<id>/` |
| 5 | CPU 隔离 | 默认串行/低并发，不抢 burn-in 进程 |
| 6 | 产物隔离 | sim JSONL 独立 schema 前缀，不混入线上 telemetry |

## 保真度分层（MVP 边界）

- **确定性事件**（己方移动/采集/存款/经济/容量）→ MVP 实现目标：与真实 tick 一致
- **不可预测**（refill / 对手动作 / 视野外）→ 显式标记 unknown；差异分类报告
- 校准验证：burnin 真实序列重放，输出**可解释差异率**（不要求绝对一致率）

## S.U.P.E.R 评估摘要

- **Simplicity**：MVP 砍 combat/respawn/对手——只做确定性经济闭环
- **Uniformity**：类型/数值与 arena-hero-ts 同源；规则数值只从 game-rules.md 读取
- **Predictability**：结算纯函数、随机源显式注入、同一输入同一输出
- **Extensibility**：结算步骤注册表，combat/respawn 后续注册；对手模型接口留出
- **Resilience**：未知区域不崩溃（unknown 标记）；校准差异全量报告

## 风险

| 风险 | 缓解 |
|---|---|
| 规则数值误解 → 模拟器"自信地错" | Golden Simulation 校准；可解释差异率 100% 门槛 |
| refill/对手不可预测 → 模拟器用不了 | 相对比较用途（同环境 A/B），不追求绝对预测 |
| 隔离被破坏 → 误提交线上 | import 禁令脚本 + 无 .env 加载 + 无 WS 连接（从代码结构上无提交能力） |
| GPT 在模拟器噪声上过度优化 | 模拟器只筛 top 候选，真实验证仍走线上 A/B |
