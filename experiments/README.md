# experiments/ — legacy Python 实验定义

> **状态：只读历史归档。** 这些 YAML 曾驱动已删除的 `src/arena_bot` Python runtime。
> 新实验必须显式迁移到 TS config、Planner benchmark 或 simulator A/B。

## 重要裁决（#8）

**per-tick LLM 直控（`strategy: llm`）与 15s 游戏窗口结构性不兼容**（冷启动 22.8s ≫ 14s deadline）。
生产路径 = DeterministicPlanner + 异步 MacroPolicy + Safety fallback。因此：

- 所有 `exp-llm*.yaml` 描述的 LLM 逐 Tick 决策路线**已不被采纳**，仅存档参考；
- 新的策略实验应走 TS 编排层（`npm run arena:shadow` / `arena:live`）+ DeterministicPlanner 变体。

## 文件清单

| 文件 | 内容 | 状态 |
|------|------|------|
| `exp-accumulate.yaml` | balance 策略攒资源（巡逻半径对比） | legacy，数据收集用 |
| `exp-llm*.yaml` | 已退役的多账号与单账号 LLM 直控实验 | legacy，路线已否决 |

不要直接运行这些 YAML；复现实验时重新建立 TS 配置和证据。
