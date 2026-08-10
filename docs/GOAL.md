# GOAL — 项目目标与策略评估

最后更新：2026-08-10

## 目标

构建**确定性、资源高效、可评测**的 Arena Hero 策略：

- 在确定性模拟器中离线验证行为，再通过差分回放保护状态/协议兼容性；
- 用可复现的指标评估资源获取效率（见 `efficiency-trace-v1.md`）；
- 防御优先：共享世界中保护 Core 与资源，威胁阶段自动转入军事模式。

策略效果通过 [Efficiency Trace v1](efficiency-trace-v1.md) 评测；迁移一致性
由 [Differential Record v1](differential-record-v1.md) 保护。两者严格分离。

## 经济机制速览（规则 v0.10）

```
Core 容量 = max(10, 人口 × 5)     # 人口 = 存活单位数（不含 Core）
```

| 目标资源 | 所需人口（容量够装） | 说明 |
|---|---:|---|
| 20 | 2 | 10+2×5=20 |
| 30 | 4 | 10+4×5=30 |
| 50 | 8 | 10+8×5=50 |

- Worker 每 Tick 采集 1 资源（持有 Beacon 时 2，节点消耗同量）
- 资源产出全部积累到 Core 容量上限；**容量不够装的部分无法存放**（Worker 只能交付装得下的量，超容量会销毁）
- 因此攒大额必须先扩人口（扩容量），再积累

## 防御风险（重要）

- **共享世界，其他玩家可能来攻打**
- Core 被摧毁时：**库存资源归本 Tick 对 Core 造成最高伤害的玩家**（平局按 UUID）；赢家 Core 也死则全部销毁
- 威胁阶段（近敌）自动进入 MILITARY：停止产 Worker，Vanguard 优先
- 守备设计（accumulate 模式）：
  - `guard_resources`：Core 资源 ≥ 此值即"值得抢"，触发守备
  - `guard_force`：守备兵力目标数（Vanguard/Ranger 交替生产，守家）
  - 资源越多越需要守家兵力；Worker 照常采集，兵力不出击远追（守家优先已内置）

## 产出策略（accumulate 模式）

| 阶段 | 行为 |
|---|---|
| 扩张期 | 正常造 Worker 到容量目标（攒 30 需 pop≥4，攒 50 需 pop≥8） |
| 积累期 | 资源 < 目标：停止 spawn，全部产出存 Core |
| 守备期 | 资源 ≥ guard_resources：兵力 < guard_force 时优先造兵 |
| 达标 | 资源 ≥ accumulate_target：不消费、日志提示达标；达标后自动回积累期 |

这些战略意图由 planner/config 或后续低频 MacroPolicy 表达。

## 多实例部署

- 每实例独立进程、single-writer lock、manifest 与 JSONL telemetry；
- 部署由配置驱动（`runtime/configs/*.json`），不写死本机路径；
- 实例产出对比：Digital Twin、Runtime-Golden 与有界真机交替窗口。

## 限流（详见 docs/LIMITS.md）

- 每账号 (tick, source) 有提交配额 → 本 agent 每 Tick 最多提交 1 次，余量巨大
- 每账号并发命令体有限 → 单进程单提交，安全
- SDK 自动尊重 Retry-After + 指数退避
