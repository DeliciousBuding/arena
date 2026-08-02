# MASTER.md — Arena Hero 重构进度主控（已归档 2026-08-02，重构完成）

最后更新：2026-08-02 16:30

**任务**：把 arena 从单文件战术脚本重构为 uv 管理的规范工程（状态机决策 + 日志 + 环境记忆 + HTTP 调试介入）。

**跟踪模式**：LOCAL_ONLY（无 git remote，无 GitHub 依赖）

## 文档链接

- 分析：`docs/analysis/`（project-overview / module-inventory / risk-assessment）
- 计划：`docs/plan/`（task-breakdown / dependency-graph / milestones）
- 进度：本文件 + `docs/progress/phase-*.md`

## 治理面解析

| 面 | 解析结果 |
|---|---|
| 指令面 | `CLAUDE.md`（Phase 5 E3 更新） |
| Memory 面 | 不新建——本项目无 native memory，以 CLAUDE.md + docs/ 为唯一知识面 |
| 秘钥 | `.env` gitignore，永不入仓 |

## 阶段总览

- [x] Phase A: 工程基座 (3/3 tasks) — `docs/progress/phase-a-baseline.md`
- [x] Phase B: 核心库 (3/3 tasks) — `docs/progress/phase-b-core.md`
- [x] Phase C: 决策内核 (2/2 tasks) — `docs/progress/phase-c-decision.md`
- [x] Phase D: 状态机+调试 (3/3 tasks) — `docs/progress/phase-d-stateful-debug.md`
- [x] Phase E: 集成切换 (4/4 tasks) — `docs/progress/phase-e-switchover.md`

## 任务 → 批次映射

| 任务 | 批次 | 提交批次说明 |
|---|---|---|
| A1-A3 | Batch 1 | 基座：pyproject + 包结构 + pytest 配置 |
| B1-B3 | Batch 2 | 核心：日志 + 记忆 + 状态适配 |
| C1-C2 | Batch 3 | 决策 I：策略接口 + Balance 迁移 |
| C3-C4, D1 | Batch 4 | 状态机 + 调试端点 |
| D2, E1-E3 | Batch 5 | 集成、验证、切换、归档 |

## Current Status

- 正在：Phase B 任务 B1（日志系统）
- 线上：旧 tactic.py 继续后台运行（b5j5ardxo），切换前不停

## Next Steps

1. B1: logging_util.py（轮转 + stdout 双写 + [tick] 关联）
2. B2: world.py 环境记忆
3. B3: core/state.py Turn 适配层

## Adaptive Control State

| 里程碑 | drift_score | 阈值(标注/重规划/重范围) | 状态 |
|---|---|---|---|
| M1 基座 | 0 | 0.6 / 1.2 / 1.8 | 正常 |
| M2 核心库 | 0 | 0.6 / 1.2 / 1.8 | 正常 |
| M3 决策无回归 | 0 | 0.4 / 0.8 / 1.2 | 正常 |
| M4 可调试运行 | 0 | 0.6 / 1.2 / 1.8 | 正常 |
| M5 线上切换 | 0 | 0.8 / 1.6 / 2.4 | 正常 |

## Task Telemetry Log

| 任务 | 实际工作量 | S.U.P.E.R | 未计划依赖 | 备注 |
|---|---|---|---|---|
| A1 pyproject+uv | S | — | uv 默认 Python 3.14（需验证 SDK 兼容） | 38 例全过 |
| A2 包结构+config | M | S+E 提升 | — | frozen dataclass + with_param |
| A3 pytest 配置 | S | — | pythonpath 需含根目录（旧 import tactic） | 43 例全绿 |
