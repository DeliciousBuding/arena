# Implementation Mapping — Race v1

`StrategyProfile v1` 是跨线输入。实现可以忽略尚未支持的可选字段，但必须在 manifest 中列出 `unsupportedFields`，不得静默使用不同默认值。

## 1. 字段映射

| Race v1 | TS | Fusion Go/Rust | 规则 |
|---|---|---|---|
| `posture=economic` | `harvest` | `Growth` / economic | adapter 映射，不改 schema 枚举 |
| `posture=balanced` | `balanced` | balanced/default | 直接映射 |
| `posture=aggressive` | `aggressive` | aggressive/directive | 直接映射 |
| `workerTarget` | MacroPolicy / planner config | Rust `Config.worker_target` | 不允许各自隐藏另一默认值 |
| `populationCeiling` | planner config | Rust `population_ceiling` | profile 权威 |
| `militaryRatio` | 0–1 number | Rust 当前百分数 0–100 | Fusion adapter 负责 ×100 与边界检查 |
| `vanguardRatio` | 0–1 number | 待 Rust 支持 | 未支持必须上报 |
| `accumulateThreshold` | surge 状态机 | 待 Rust 支持 | 未支持不得伪装等价 |
| `attackForce` | surge 前压门槛 | 待 Rust 支持 | 未支持不得伪装等价 |
| `exploreRadius` | planner config | Rust `explore_radius` | 直接映射 |
| `maxFocusDistance` | SafetyPlanner | Go Commander/Rust focus guard | 两层都可防御，但 manifest 记录最终值 |
| `threatDistance` | planner config | Rust `threat_distance` | 直接映射 |
| `spawnReserve` | planner config | Rust `spawn_reserve` | 直接映射 |
| `attackPriority=core` | `attackPriority=core` | enemy core target | adapter 映射 |
| `attackPriority=workers` | `attackPriority=workers` | worker/economy target | adapter 映射 |
| `attackPriority=nearest` | null/nearest fallback | nearest target | 显式值，不靠 null 猜测 |
| `attackPriority=null` | null | no forced target | 直接映射 |
| `resourceMemory.*` | World/WorkerTaskPlanner | Rust ResourceMemory | 未实现前上报 |
| `exploration.*` | deterministic exploration | Rust ExplorationMemory | 两边可有不同算法但同参数语义 |
| `safety.clearPath` | planner variant | Rust/Go guard | 直接映射或上报未支持 |
| `safety.enableCoreMigration` | planner config | Rust `enable_core_migration` | 默认 false，生产启用需单独晋级 |

## 2. 单位与比例

- 所有 ratio 在跨线契约中使用 `[0,1]` 浮点数；
- 实现内部若使用百分数，adapter 必须显式转换并记录规范化值；
- Tick、距离、资源、人口均为整数；
- 坐标允许负整数；
- profile 不携带租户 secret、绝对运行路径或 provider token。

## 3. 默认值

跨线正式赛马不使用实现默认值。调用方必须传完整 profile，并在 manifest 中记录：

```text
profileId
profileSchemaVersion
profileHash
normalizedProfile
unsupportedFields
```

实现默认值只允许用于语言内单测或开发命令；正式结果若 `profileHash` 缺失则不具备晋级资格。

## 4. 计划差异

TS 与 Rust 不要求逐动作一致。以下情况允许登记差异：

- 不同但均合法的巡逻方向；
- Rust 更早治疗或 TS 更早前压；
- 资源/敌人记忆实现不同导致的目标差异。

以下情况不属于允许差异：

- 违反 validator；
- state/tick/schema 解析不一致；
- 不同单位成本、视野、容量或结算规则；
- 同 profile 被 adapter 改成不同数值；
- FFI 丢失 planner 跨 Tick 状态。
