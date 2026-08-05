# Evaluation Contract — Race v1

## 1. 评价原则

Race 只比较可复现窗口。每个窗口必须绑定：

- implementation / git SHA / config hash / rules evidence；
- scenario / seed set / tick count；
- hard gate 计数；
- 原始或汇总证据路径；
- 同一评分代码版本。

单次最好 seed、不同场景、不同 refill 假设、不同初始人口之间不得直接排名。

## 2. Hard Gates

任一字段大于 0，窗口 `eligible=false`，不计算总分：

```text
wrongTickSubmit
duplicateSubmit
staleCandidateExecuted
illegalFinalPlan
secondWriter
crossTenantStateLeak
orphanProcess
unhandledKernelPanic
credentialLeak
unknownRepair
silentKernelFallback
```

补充规则：

- shadow 模式没有真实 submit 时，submit 类字段记 0，但必须标记 `submissionMode=shadow`；
- `INCONCLUSIVE` 不算 MATCH，也不自动算失败；必须保留分类；
- Fusion 发生 FFI fallback 时，即使 Go fail-safe 保持租户运行，本次 Fusion 赛马窗口也失效；
- deterministic 与 deterministic-rust 的非法计划处置必须同等 fail-closed。

## 3. 统一指标

### 3.1 Core 生存与恢复（35 分）

- `coreSurvivalRate`：窗口末 Core 存活比例；
- `coreHpAuc`：Core HP 随时间面积，归一化到 `[0,1]`；
- `respawnRecoveryTicks`：Core 重生后恢复到最低经济闭环所需 tick；
- `catastrophicLosses`：Core 销毁且规定时间内未恢复次数。

建议分数：

```text
35 × clamp(
  0.45 * coreSurvivalRate
+ 0.35 * coreHpAuc
+ 0.20 * recoveryScore,
0, 1)
```

### 3.2 净经济收益（30 分）

禁止只用最终 resources。统一净经济：

```text
netEconomy =
  finalResources
+ survivingUnitAssetValue
+ grossDeposited
+ confirmedLoot
- upkeepPaid
- lostUnitAssetValue
- healCost
- failedSpawnCost
```

必须同时报告：

- `grossDeposited`
- `netEconomy`
- `resourceDelta`
- `workerProductiveTicks`
- `travelWasteTicks`
- `cargoBlockedTicks`

评分用同场景基线归一化，不在 schema 中硬编码单位价格；价格表属于 rules fixture。

### 3.3 有效探索（15 分）

- `newVisibleCells`
- `valuableDiscoveries`：首次发现可采资源或有效敌情；
- `firstResourceDiscoveryTick`
- `duplicateCoverageRatio`
- `emptyExploreTicks`
- `maxUsefulDistance`：仅统计产生发现/采集/情报价值的距离，不用纯最大位移。

### 3.4 战斗与拆 Core（10 分）

- `enemyCoreDamage`
- `enemyCoreDestroyed`
- `combatValueTrade`
- `militarySurvivalRate`
- `defenseLeakCount`

经济场景中该项应设 `applicable=false`，剩余权重按比例重分配，不能强行给 0。

### 3.5 系统稳定性（10 分）

- decision latency p50/p95/max；
- reconnect recovery time；
- RSS/CPU；
- clean shutdown；
- lock release；
- telemetry completeness；
- deterministic replay repeatability。

## 4. 场景矩阵

Race v1 最少包含：

| ID | 场景 | 核心问题 |
|---|---|---|
| economy-dense | 近距离持续资源 | 基础雪球、拥堵 |
| economy-sparse | 稀疏资源 | 记忆与发现效率 |
| resource-far | 32–48 格外资源 | 长程探索与回仓 |
| obstacle-maze | 长墙/窄口 | BFS 与路径预约 |
| core-gate | Core 入口拥堵 | deposit/spawn 破锁 |
| enemy-defensive | 防守型敌人 | 攻坚配比 |
| enemy-aggressive | 对攻型敌人 | 生存与反制 |
| crossfire | 双轴威胁 | Core 逃生与布防 |
| depleted | 可见资源枯竭 | blacklist/切战略 |
| reconnect | 流停顿与重连 | exactly-once/恢复 |

每个策略候选至少：

- 20 个配对 seed；
- 1000 tick 或场景终局；
- 同初态、同规则 fixture、同近似 refill 配置；
- 输出均值、中位数、最差 10%、标准差、失败率。

开发阶段可以用 2–3 seed 小窗筛选，但不得作为正式晋级证据。

## 5. 统计裁决

候选相对当前生产基线晋级，至少满足：

1. hard gate 全 0；
2. 主要目标指标均值提升；
3. 最差 10% 不恶化超过 5%；
4. 失败率不增加；
5. 至少两个不同场景族成立；
6. 结果可由另一实现或独立 runner 重放。

若均值提升但尾部显著变差，保留为实验 profile，不进入生产。

## 6. 结果产物

每次正式赛马生成一个满足 `race-result-v1.schema.json` 的 JSON，建议路径：

```text
runtime/race/<race-id>/result.json
runtime/race/<race-id>/raw/
runtime/race/<race-id>/summary.md
```

`runtime/**` 默认不入 Git；仓库只提交小型 fixture、profile、评分代码和经审查的摘要数字。
