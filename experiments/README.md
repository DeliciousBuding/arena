# experiments/ — legacy Python 实验定义

> **状态：legacy（迁移期间保留）。** 这些 YAML 驱动 `src/arena_bot` Python 运行时。
> 迁移主线是 TS（`packages/arena-agent`），Python 侧只做数据收集与回滚链，W6 后删除。

## 重要裁决（#8）

**per-tick LLM 直控（`strategy: llm`）与 15s 游戏窗口结构性不兼容**（冷启动 22.8s ≫ 14s deadline）。
生产路径 = DeterministicPlanner + 异步 MacroPolicy + Safety fallback。因此：

- `exp-llm-4.yaml` / `exp-llm-t4.yaml` 描述的 LLM 逐 Tick 决策路线**已不被采纳**，仅存档参考；
- 新的策略实验应走 TS 编排层（`npm run arena:shadow` / `arena:live`）+ DeterministicPlanner 变体。

## 文件清单

| 文件 | 内容 | 状态 |
|------|------|------|
| `exp-accumulate.yaml` | balance 策略攒资源（巡逻半径对比） | legacy，数据收集用 |
| `exp-llm-4.yaml` | 4 账号 LLM 并发（RPC 桥） | legacy，路线已否决 |
| `exp-llm-t4.yaml` | t4 LLM 单账号（pi 工具） | legacy，路线已否决 |

运行：`uv run python -m arena_bot.run --experiment exp-accumulate`
