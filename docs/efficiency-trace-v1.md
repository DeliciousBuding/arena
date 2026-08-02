# Efficiency Trace v1 — 资源效率评测（概念冻结 2026-08-02）

> **职责边界**：本协议只用于**策略效果评测**（哪个计划能获得更多资源）；迁移一致性（TS 是否忠实替代 Python）归 `docs/differential-record-v1.md`。两者严格分离，效率字段不得塞进 Differential Record。
> **终极目标**：攒 Core 资源 → 兑换公益站注册码（30/50 资源；容量 = max(10, 人口×5)）。

## 为什么不能拿 raw-state 直接比效率

固定历史 raw-state 序列由**历史真实行动**产生：Tick 40124 的状态是历史上执行 MOVE LEFT 的结果。拿它继续评估 MOVE RIGHT 是**反事实污染**——不能用固定历史评估不同计划的长期收益。

**可用**：真机 shadow 决策质量代理指标、真机 A/B 或交替窗口、可信游戏模拟器。
**不可用**：固定历史 raw-state 直接比较反事实资源收益。

## 两阶段

### 阶段一：Compatibility Gate（W3）
目标：**零未解释迁移差异**。通过后证明 Python 可安全退役。
产出：Differential Record v1 + 差分报告。

### 阶段二：Efficiency Benchmark（W3 之后）
目标：允许策略有意偏离 Python，评价**资源获取效率**。
产出：Efficiency Trace v1（基于权威状态和事件生成，与 Differential Record 同源不同构）。

## Efficiency Trace v1 单行结构（概念）

```json
{
  "tenant_id": "t1",
  "tick": 40123,
  "strategy_id": "safety-v1",
  "experiment_id": "exp-a",
  "core_resources": 37,
  "resource_delta": 2,
  "gross_deposit": 3,
  "spend": {"spawn": 0, "heal": 1, "repair": 0},
  "harvest_succeeded": 1,
  "harvest_failed": 0,
  "population": 5,
  "fallback": false,
  "deadline_miss": false
}
```

（schema 待 Efficiency Benchmark 立项时冻结，此处只固定字段语义。）

## 资源效率 KPI（词典序，不揉总分）

### 一级目标（主指标）

| 指标 | 定义 | 方向 |
|------|------|------|
| `ticks_to_redemption_target` | 固定起始条件 → 兑换所需资源阈值的 Tick 数 | 越低越好 |
| `core_resource_gain_per_100_ticks` | 长窗口 Core 资源增长斜率（500–2000 Tick 窗口，跳过 warm-up） | 越高越好 |

### 二级解释指标

```
gross_deposit_resources     采集总量
resource_spend_by_action    按动作消费（spawn/heal/repair）
harvest_success_count       采集成功数
harvest_failure_count       采集失败数
worker_cargo_idle_ticks     Worker 空闲 tick
core_full_ticks             容量满 tick
unit_death_count            单位死亡数
respawn_downtime_ticks      复活等待 tick
empty_plan_rate             空计划率
invalid_action_rate         非法动作率
repair_rate                 修复率
deadline_miss_rate          超时率
tick_mismatch_rate          错 tick 率
safety_fallback_rate        Safety 兜底率
```

### 约束指标（优化不得牺牲）

```
重复提交 = 0
错 Tick 提交 = 0
孤儿进程 = 0
未处理异常退出 = 0
deadline miss < 预设阈值
```

### 词典序裁决

```
先满足安全约束
→ 再最小化 ticks_to_target
→ 再最大化 resource_gain_per_100_ticks
→ 再比较成本（token/cost）和稳定性
```
