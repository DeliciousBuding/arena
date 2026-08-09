# 模拟器性能测量报告（L-A 线，2026-08-09）

日期：2026-08-09 · 来源：L-A subagent 计时探针（默认关，零行为变化）+ 总负责人补测
代码：arena-ts 工作树（main 之上未提交的计时改动：`opponent-bridge.py` ARENA_BRIDGE_TIMING、
`sync-bridge.ts`/`opponent-adapter.ts` 桥往返计时、`episode.ts` ARENA_EPISODE_TIMING 分阶段计时）

## 1. 阶段耗时分布（10 玩家 ffa-std，1000 tick，流水线模式）

探针 `docs/analysis-probe-e1.log`（`ARENA_EPISODE_TIMING=1`）：

```
TOTAL ticks=1000 avg_tick=50.3ms  decision=21.2ms  settlement=2.8ms  prefetch=26.0ms  record=0.2ms
占比：decision 42% · prefetch 52% · settlement 5.6% · record 0.4%
```

- **prefetch 26ms（52%）是大头**：观察（observeAndPolicy）+ 状态 JSON 序列化 +
  桥提交（pipeline 模式结算后立即预取）。这是"桥状态投影"的靶心。
- **decision 21.2ms（42%）**：含桥 Python 决策等待（Python 侧 parse/validate/decide/dump）。
- **settlement 仅 2.8ms（5.6%）**：引擎结算非瓶颈（与 98.3% idle 剖析一致）。
- avg_tick 随 tick 数增长（30.1ms@100 → 50.3ms@1000）：单位数增多，决策/序列化变大。

## 2. 桥消息体积（探针 b1/t1）

`ARENA_BRIDGE_TIMING=1` 输出的 reqBytes/respBytes 记录在 `docs/analysis-probe-b1.log`、
`docs/analysis-probe-t1.log`（单场全量采样 ~1-2MB 级日志）。要点：每 tick 每桥一次
完整 PlayerState 往返（含全部单位/视野/地形），**状态序列化体积随单位数线性增长**。

## 3. 结论与抓手建议（按收益排序）

1. **桥状态投影**（预估 20-30% 端到端）：prefetch 序列化只传决策所需字段子集。
   风险：第三方 agent 读取字段不可控 → 必须静态分析各 agent 实际读取的 state 字段
   并集后再投影，否则破坏逐字节一致性（评测验证基线）。**需先做字段并集审计**。
2. **决策窗口放宽**：评测路径未启用 decisionBudgetMs（仅 sim-server 生产模式 200ms），
   评测端此项无收益；生产 sim-server 侧已由 200ms 护栏保护，不建议动默认。
3. **桥跨场复用**：每场冷启动 Python + 模型加载 ~1-2s（15 场 ~20s 固定开销，占
   流水线全量评测 ~5 分钟的 <7%）——收益有限，可做但优先级低。
4. **Python 决策本身**：decision 21.2ms 中 Python 侧 parse/validate（pydantic）与
   decide 是大头（L-C 的 Turn.decision_ms 遥测可细化）——属 SDK 层优化空间。

## 4. 遗留

- 状态投影实现未落地（需字段并集审计先行）；计时工具已就绪（默认关）。
- 完整 15 场流水线评测再测速（基线 ~4-5 分钟）待状态投影后对比。
