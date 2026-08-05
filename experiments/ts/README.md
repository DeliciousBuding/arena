# experiments/ts/ — TS 实验 manifest（候选晋级流水线入口）

> **状态：TS-only 主线（TS-003）。** 旧 `experiments/*.yaml` 是 Python 历史归档（只读）。
> 本目录存放**声明式实验 manifest**（JSON），由 `src/sim/tools/experiment-manifest.ts`
> 校验，供 TS-007 扩展后的 `runAB` 消费。

## 流程

```text
manifest（本目录）
→ sim A/B（runAB）
→ report（burn-in KPI / ABReport）
→ approval
→ bounded real window
→ promote / rollback
```

## 字段契约（全部必填）

| 字段 | 说明 |
|---|---|
| `experimentId` | 唯一 id（如 `economy-v1-grid`） |
| `hypothesis` | 一句话假设（可证伪） |
| `baselineVariant` / `candidateVariant` | TS-004 `PlannerVariant` registry 的 id，二者必须不同 |
| `rulesVersion` | 规则版本（当前 `v0.11`） |
| `seeds` | 正整数 seed 数组（≥1，配对对比） |
| `ticks` | episode tick 数（正整数） |
| `primaryMetric` | 晋级主指标（如 `net_core_gain_per_100_ticks`） |
| `guardrails` | P0 指标硬上限数组 `{metric, max}`；`max: 0` = 必须恒为 0 |
| `configHash` | 变体配置稳定哈希（`sha256:` 前缀） |
| `gitSha` | 冻结基线 commit（实验发起时锁定） |

## 模板

```json
{
  "experimentId": "example-grid",
  "hypothesis": "candidate variant improves primary metric without violating guardrails",
  "baselineVariant": "deterministic-v0.2.15",
  "candidateVariant": "economy-v1",
  "rulesVersion": "v0.11",
  "seeds": [1, 2, 3, 4, 5, 6],
  "ticks": 500,
  "primaryMetric": "net_core_gain_per_100_ticks",
  "guardrails": [
    { "metric": "illegal_plan_count", "max": 0 },
    { "metric": "capacity_wait_count", "max": 10 }
  ],
  "configHash": "sha256:example",
  "gitSha": "0000000000000000000000000000000000000000"
}
```

## 红线

- 产物一律标 `exploratory`（refill 未实现，长程经济曲线不称 Golden）；
- `baselineVariant` 冻结后不可变，变体实验重新 manifest；
- 不把模拟器输出当服务器 Golden（INCONCLUSIVE 语义保持）。
