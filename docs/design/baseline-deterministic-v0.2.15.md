# 冻结基线：deterministic-v0.2.15

> TS-002。所有离线 Planner 提升（TS-008 economy-v1、TS-009 clear-path-v1）**必须相对此基线衡量**；
> 基线本体不可变，变体实验用新 manifest。

## 冻结内容

| 项 | 值 |
|---|---|
| 变体 id | `deterministic-v0.2.15`（`src/sim/tools/planner-variants.ts` registry） |
| 基线 commit | `8d91980`（TS-004 落地时刻；v0.2.15 生产修复链之后） |
| 规则版本 | `v0.11`（`src/sim/contracts/rules-v0.11.json`；引擎已实现 v0.12/v0.13 语义但 manifest 声明保持 v0.11） |
| 配置 | `runtime/configs/t1.json` 语义（workerTarget 由 MacroPolicy 驱动，floor=2） |
| 标准 seeds | `[1, 2, 3, 4, 5, 6]`（配对 A/B 最小集；网格实验可扩） |
| 标准 ticks | `500`（长程经济评估；refill 未实现 → 产物标 exploratory） |
| 语义校准（TS-008） | **无 focusRegion 防呆**（`maxFocusDistance=Infinity`）——v0.2.15 发布时的真实行为；生产 t1 经济冻结事故（2026-08-05）暴露的原始语义。A/B 对照候选（如 `deterministic-v0.2.17`）时，焦点远征差异可被模拟回归测试直接衡量 |

## 生产死锁复现场景（基线回归夹具）

| 场景 | 位置 |
|---|---|
| 满载回仓被敌群围堵（三面/四面） | `test/nav-pathfinding.test.ts` |
| 资源满让位 + SPAWN 解锁闭环 | `test/economy-loop.test.ts` |
| 敌 CORE 挡回仓（w1 @[-316,57] 战役） | `test/nav-pathfinding.test.ts` |
| Core SELF_DESTRUCT 时序（combat 后） | `test/sim-combat.test.ts` |
| **focus 远征**（policy focusRegion=远点，基线被支走 vs 候选留守） | `test/sim-tools.test.ts` TS-008 + `test/fixtures/sim/scenario-focus-exile.json` |

## KPI 衡量方式（TS-001）

```text
buildBurnInReportWithKpi(runtime, decisions, outcomes, policies)
→ gates（门禁）+ kpi（grossDeposit/spawn/heal/unitLoss/capacityWait/stall/
  ticks_to_20/30/50/policy counts）
→ telemetry_gap 明确标记不可精确计算的指标（policy latency/upkeep/travel waste/clear ROI）
```

## 晋级门槛（相对基线）

```text
net_core_gain_per_100_ticks 中位数提升 ≥10%
P0 指标全部为 0（illegal_plan_count / capacity_wait 长时间持续等 guardrails）
P10 不出现灾难性回退
```

## 红线

- 基线 commit 冻结后不可改；实验 manifest 的 `gitSha` 必须写实验发起时的基线 SHA；
- 模拟器产物一律标 `exploratory`（refill/敌方 AI 失真未解），不称 Golden；
- 生产默认行为不因 registry 存在而改变（`deterministic` 别名 = 当前语义 `deterministic-v0.2.17`，
  与冻结基线 `deterministic-v0.2.15` 是**两个不同变体**——防呆差异由 A/B 衡量）。
