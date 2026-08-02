# Module Inventory — 现状模块清单与 S.U.P.E.R 评估

最后更新：2026-08-02（Phase 1 分析）

## 模块清单

| 模块 | 职责 | 规模 | 公开面 | 依赖 |
|---|---|---|---|---|
| `tactic.py` | 全部：连接循环、decide_actions 决策、print 日志、.env 读取 | 300 行 | `decide_actions(turn)`、`play(api_key)` | arena_hero |
| `tests/test_tactic.py` | 决策测试（Fake Turn/Unit 鸭子类型） | 477 行 | 38 用例 | pytest, tactic |
| `scripts/diagnose.py` | 只读诊断一帧状态 | 34 行 | — | tactic, arena_hero |
| `scripts/sync_docs.py` | skill references → docs/ | 38 行 | — | — |
| `docs/*` | 离线契约文档 | 4185 行 | — | — |

## S.U.P.E.R 评分（现状基线）

| 原则 | 分 | 说明 |
|---|---|---|
| **S**ingle Responsibility | 2/5 | tactic.py 混合连接/决策/日志/配置读取四层职责；无模块边界 |
| **U**nderstandability | 3/5 | decide_actions 函数清晰、注释中文、常量集中；但无状态机/流程文档，行为靠读代码猜 |
| **P**redictability | 4/5 | 确定性设计（UUID 排序/固定轴优先）；38 例测试验证分支；SDK 类型化状态兜底 |
| **E**volvability | 2/5 | 无状态扩展点：想加记忆/策略/调试接口都要在单文件里堆 if；无包结构 |
| **R**eliability | 3/5 | SDK 重连/幂等兜底 + 测试；但日志仅 stdout（进程重启即失），无 tick 关联持久记录，无健康自检 |

## 违反热点（重构优先目标）

1. **S/E 热点 — 无模块边界**：连接、决策、日志、配置、记忆全部在 tactic.py。
2. **E 热点 — 决策无抽象**：策略常量硬编码（EXPLORE_RADIUS、WORKER_TARGET、POP_CEILING），换策略=改代码。
3. **R 热点 — 无持久日志**：print 到 stdout，后台运行无法追溯历史 tick；无轮转、无级别、无结构化字段。
4. **E 热点 — 无状态记忆**：每 Tick 从零决策；障碍记忆（永久地形）丢失、采集意图（HARVEST_FAILED 重撞）丢失、敌人跟踪丢失。
5. **E 热点 — 无人工介入**：改行为只能停进程改代码；无法查看运行态内部状态。
6. **S/E 热点 — 无项目声明**：无 pyproject.toml，依赖靠全局 pip，环境不可复现。

## 保留资产（不重构）

- 确定性决策函数与 38 例测试逻辑（迁移进新结构）
- .env 秘钥机制与 gitignore 红线
- docs/ 离线契约文档与 CLAUDE.md 指令面
- 巡逻半径/动态 reserve/错向巡逻等实测调优参数
