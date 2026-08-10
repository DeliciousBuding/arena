# 变体库存（variant inventory，唯一权威清单）

状态：2026-08-08（命名规范核验）。

## 0. 数据口径（抽查对照依据）

- **注册表**：`packages/arena-agent/src/strategies/variant-registry.ts`（行号 = 该文件当前版本行号）。
- **启用范围**：`runtime/configs/*.json` 的 `variants` 数组声明启用；`-` = 默认未启用（具体部署以各自配置为准）。
- **代码读取**：`rg -l "<flag>" packages/*/src` 命中**文件数**（排除
  variant-registry.ts 自身；`src/` 含 arena-agent / arena-hero-ts / command-center
  各包源码目录）。同一 flag 多文件用 `/` 分隔列数；"空覆盖"变体无 safety 侧字段。
- 注册表与 configs 的配对语义：config `variants` 数组声明 id → 运行时
  `resolveSafetyVariantConfig` / `resolveDeterministicVariantsConfig` 解析为
  SafetyPlanner 配置覆盖与 DeterministicPlanner 参数覆盖；未知 id fail-fast。

## 1. VARIANT_SAFETY_CONFIG（42 项，variant-registry.ts L15-271）

| id | flag | 参数 | 代码读取 |
| ---- | ------ | ------ | ---------- |
| clear-path-v1 | clearPath=true | — | clearPath: 2 |
| core-threat-watch-v1 | coreThreatWatch=true | — | coreThreatWatch: 2 |
| threat-recall-v1 | threatRecall=true | — | threatRecall: 3 |
| reinforce-home-v1 | remoteReinforce=true | — | remoteReinforce: 2 |
| beacon-grab-v1 | beaconGrab=true | beaconGrabMaxDist=80 | beaconGrab: 3 / beaconGrabMaxDist: 2 |
| move-failed-avoidance-v1 | moveFailedAvoidance=true | — | moveFailedAvoidance: 4 |
| threat-adaptive-defense-v1 | threatAdaptiveDefense=true | — | threatAdaptiveDefense: 2 |
| assault-overmatch-v1 | assaultOvermatch=true | — | assaultOvermatch: 2 |
| alliance-no-fire-v1 | allianceNoFire=true | — | allianceNoFire: 2 |
| rally-assault-v1 | rallyAssault=true | — | rallyAssault: 2 |
| outnumbered-retreat-v1 | outnumberedRetreat=true | — | outnumberedRetreat: 2 |
| weak-core-first-v1 | weakCoreFirst=true | — | weakCoreFirst: 2 |
| threat-sector-scout-v1 | threatSectorScout=true | — | threatSectorScout: 2 |
| raid-defense-v1 | raidDefense=true | — | raidDefense: 2 |
| core-clearance-v1 | coreClearance=true | — | coreClearance: 2 |
| worker-dense-scan-v1 | workerDenseScan=true | — | workerDenseScan: 2 |
| frontier-priority-v1 | frontierPriority=true | — | frontierPriority: 2 |
| vanguard-heavy-v1 | （空覆盖，safety 无开关） | — | —（deterministic 侧见 §2） |
| core-moving-hold-v1 | coreMovingHold=true | — | coreMovingHold: 3 |
| spawn-yield-v1 | spawnYield=true | — | spawnYield: 2 |
| worker-blockade-v1 | workerBlockade=true | — | workerBlockade: 2 |
| vanguard-blockade-v1 | vanguardBlockade=true | — | vanguardBlockade: 2 |
| harvest-memory-mine-v1 | harvestMemoryMine=true | —（harvestMemoryMaxDist 缺省取 HARVEST_MEMORY_MAX_DIST） | harvestMemoryMine: 3 / harvestMemoryMaxDist: 2 |
| vanguard-prey-worker-v1 | vanguardPreyWorker=true | — | vanguardPreyWorker: 3 |
| military-priority-v1 | threatMilitaryPriority=true | —（threatMilitaryFloor 缺省 4） | threatMilitaryPriority: 2 / threatMilitaryFloor: 2 |
| threat-breakout-v1 | threatBreakout=true | — | threatBreakout: 2 |
| core-evade-v1 | coreEvade=true | — | coreEvade: 3 |
| core-evade-persist-v1 | coreEvade=true, coreEvadePersist=true | — | coreEvade: 3 / coreEvadePersist: 2 |
| core-evade-ttr-v1 | coreEvade=true, coreEvadeTtr=true, coreEvadePersist=true | — | coreEvade: 3 / coreEvadeTtr: 2 / coreEvadePersist: 2 |
| guard-axes-v1 | guardAxes=true | — | guardAxes: 2 |
| guard-heal-rotation-v1 | guardHealRotation=true | — | guardHealRotation: 2 |
| detached-squad-v1 | detachedSquadResponse=true | — | detachedSquadResponse: 2 |
| bounded-raid-v1 | boundedRaid=true | — | boundedRaid: 2 |
| scout-evade-v1 | scoutEvade=true | — | scoutEvade: 2 |
| ranger-memory-shot-v1 | rangerMemoryShot=true | — | rangerMemoryShot: 2 |
| military-frontier-scavenge-v1 | militaryScavengeFrontier=true | — | militaryScavengeFrontier: 2 |
| strike-core-v1 | aggression="aggressive" | attackForce=6, boundedRaid=true, rangerMemoryShot=true, strikeGroupReserve=true, militarySearchDense=true, militaryRingHoldTicks=20, enemyCoreMemoryTicks=1200, militaryHunt=true | aggression: 4 / attackForce: 3 / boundedRaid: 2 / rangerMemoryShot: 2 / strikeGroupReserve: 2 / militarySearchDense: 2 / militaryRingHoldTicks: 2 / enemyCoreMemoryTicks: 2 / militaryHunt: 3 |
| population-ceiling-30-v1 | populationCeiling=30 | — | populationCeiling: 3 |
| population-ceiling-35-v1 | populationCeiling=35 | — | populationCeiling: 3 |
| worker-mission-v1 | （空覆盖，safety 无开关） | — | —（mission 见 §2；`\bmission\b` 全 src 16 文件词义过宽，属性访问 `.mission` 5 文件） |
| recovery-early-military-v1 | （空覆盖，safety 无开关） | — | recoveryEarlyMilitary: 1（deterministic 侧） |
| lean-spend-v1 | （空覆盖，safety 无开关） | — | spawnReserve: 2（deterministic 侧） |

注册行号（抽查用）：clear-path-v1 L17、core-threat-watch-v1 L26、threat-recall-v1
L27、reinforce-home-v1 L35、beacon-grab-v1 L42、move-failed-avoidance-v1 L43、
threat-adaptive-defense-v1 L52、assault-overmatch-v1 L60、alliance-no-fire-v1 L69、
rally-assault-v1 L77、outnumbered-retreat-v1 L84、weak-core-first-v1 L90、
threat-sector-scout-v1 L97、raid-defense-v1 L107、core-clearance-v1 L115、
worker-dense-scan-v1 L122、frontier-priority-v1 L130、vanguard-heavy-v1 L137、
core-moving-hold-v1 L146、spawn-yield-v1 L154、worker-blockade-v1 L162、
vanguard-blockade-v1 L170、harvest-memory-mine-v1 L176、vanguard-prey-worker-v1
L182、military-priority-v1 L191、threat-breakout-v1 L192、core-evade-v1 L193、
core-evade-persist-v1 L194、core-evade-ttr-v1 L200、guard-axes-v1 L201、
guard-heal-rotation-v1 L202、detached-squad-v1 L203、bounded-raid-v1 L204、
scout-evade-v1 L205、ranger-memory-shot-v1 L206、military-frontier-scavenge-v1
L207、strike-core-v1 L218、population-ceiling-30-v1 L242、population-ceiling-35-v1
L250、worker-mission-v1 L257、recovery-early-military-v1 L263、lean-spend-v1 L270。

## 2. DETERMINISTIC_VARIANT_CONFIG（5 项，variant-registry.ts L292-359）

| id | flag | 参数 | 代码读取 |
| ---- | ------ | ------ | ---------- |
| strike-core-v1 | vanguardRatio=0.5, accumulateThreshold=30 | — | vanguardRatio: 6 / accumulateThreshold: 6 |
| recovery-early-military-v1 | recoveryEarlyMilitary=true | — | recoveryEarlyMilitary: 1 |
| vanguard-heavy-v1 | vanguardRatio=0.75 | — | vanguardRatio: 6 |
| worker-mission-v1 | mission（MissionConfig） | collectionValueFloor=-30, maxCollectionDistance=24, surveyWorkerCap=3, surveyBurstTicks=100, surveyWorkerFloor=3, visibleBonus=0.3, seedAgeDecay=0.02, refillLookahead=0, refillBonus=0, deadMineOverdueTicks=Infinity, migrationScout=true, switchThreshold=1.5, surveyOnSupplyGap=true | `.mission` 属性访问 5 文件 |
| lean-spend-v1 | spawnReserve=1 | — | spawnReserve: 2 |

注册行号（抽查用）：strike-core-v1 L294、recovery-early-military-v1 L298、
vanguard-heavy-v1 L307、worker-mission-v1 L318、lean-spend-v1 L358。

## 3. 注册表外事实（漂移登记）

### 3.1 未进入权威注册表的 3 个孤儿变体

`coordinated-fire-v1`、`ranger-scavenge-v1`、`ranger-kite-v1` 出现在部分部署的
注册表中，但**权威注册表（variant-registry.ts）没有这三个 id**。

- 影响：加载含这些 id 的 `variants` 数组会 fail-fast（unknown safety variant）。
- 处理：将部署侧注册表与权威注册表对齐（登记为漂移项）。

### 3.2 注册但默认未启用的变体（6 个）

`clear-path-v1`、`beacon-grab-v1`、`bounded-raid-v1`、`ranger-memory-shot-v1`、
`threat-breakout-v1`、`population-ceiling-30-v1`。

> 注：`core-evade-v1` 在部分部署中与 `core-evade-persist-v1` / `core-evade-ttr-v1`
> 同时启用，故不计入本表；以注册表与部署配置为准。

### 3.3 附注

- `population-ceiling-35-v1` 覆盖旧 `population-ceiling-30-v1`（注册表注释，
  2026-08-08 起默认调高）；30 上限默认不再启用。
- sim 侧 `sim/tools/planner-variants.ts` 复用本注册表构造 A/B 变体（注册表头部
  注释），离线实验与部署启用读同一份事实。
