# 变体库存（variant inventory，唯一权威清单）

状态：2026-08-08（任务书 H）。数据全部实读，无编造。

## 0. 数据口径（抽查对照依据）

- **注册表**：`packages/arena-agent/src/strategies/variant-registry.ts`，main 工作树
  当前版本（2026-08-08，含未提交改动）。行号 = 该文件当前工作树行号。
- **启用租户**：`data/runtime/configs/t{1,2,3,4}.json` 的
  `variants` 数组实读（只读，2026-08-08 快照）。`-` = 无任何租户启用。
- **代码读取**：`rg -l "<flag>" packages/*/src` 命中**文件数**（排除
  variant-registry.ts 自身；`src/` 含 arena-agent / arena-hero-ts / command-center
  各包源码目录）。同一 flag 多文件用 `/` 分隔列数；"空覆盖"变体无 safety 侧字段。
- 注册表与 configs 的配对语义：config `variants` 数组声明 id → 运行时
  `resolveSafetyVariantConfig` / `resolveDeterministicVariantsConfig` 解析为
  SafetyPlanner 配置覆盖与 DeterministicPlanner 参数覆盖；未知 id fail-fast。

## 1. VARIANT_SAFETY_CONFIG（42 项，variant-registry.ts L15-271）

| id | flag | 参数 | 启用租户 | 代码读取 |
|----|------|------|----------|----------|
| clear-path-v1 | clearPath=true | — | — | clearPath: 2 |
| core-threat-watch-v1 | coreThreatWatch=true | — | t1 t2 t3 t4 | coreThreatWatch: 2 |
| threat-recall-v1 | threatRecall=true | — | t1 t2 t3 t4 | threatRecall: 3 |
| reinforce-home-v1 | remoteReinforce=true | — | t1 t2 t3 t4 | remoteReinforce: 2 |
| beacon-grab-v1 | beaconGrab=true | beaconGrabMaxDist=80 | — | beaconGrab: 3 / beaconGrabMaxDist: 2 |
| move-failed-avoidance-v1 | moveFailedAvoidance=true | — | t1 t2 t3 t4 | moveFailedAvoidance: 4 |
| threat-adaptive-defense-v1 | threatAdaptiveDefense=true | — | t1 t2 t3 t4 | threatAdaptiveDefense: 2 |
| assault-overmatch-v1 | assaultOvermatch=true | — | t1 t2 | assaultOvermatch: 2 |
| alliance-no-fire-v1 | allianceNoFire=true | — | t1 t2 t3 t4 | allianceNoFire: 2 |
| rally-assault-v1 | rallyAssault=true | — | t1 t2 t3 | rallyAssault: 2 |
| outnumbered-retreat-v1 | outnumberedRetreat=true | — | t1 t2 t3 | outnumberedRetreat: 2 |
| weak-core-first-v1 | weakCoreFirst=true | — | t1 t2 t3 | weakCoreFirst: 2 |
| threat-sector-scout-v1 | threatSectorScout=true | — | t2 | threatSectorScout: 2 |
| raid-defense-v1 | raidDefense=true | — | t1 t2 t3 t4 | raidDefense: 2 |
| core-clearance-v1 | coreClearance=true | — | t1 t2 t3 t4 | coreClearance: 2 |
| worker-dense-scan-v1 | workerDenseScan=true | — | t1 t2 t3 t4 | workerDenseScan: 2 |
| frontier-priority-v1 | frontierPriority=true | — | t1 t2 t3 t4 | frontierPriority: 2 |
| vanguard-heavy-v1 | （空覆盖，safety 无开关） | — | t1 t3 t4 | —（deterministic 侧见 §2） |
| core-moving-hold-v1 | coreMovingHold=true | — | t1 t2 t3 t4 | coreMovingHold: 3 |
| spawn-yield-v1 | spawnYield=true | — | t1 t2 | spawnYield: 2 |
| worker-blockade-v1 | workerBlockade=true | — | t2 | workerBlockade: 2 |
| vanguard-blockade-v1 | vanguardBlockade=true | — | t1 t2 | vanguardBlockade: 2 |
| harvest-memory-mine-v1 | harvestMemoryMine=true | —（harvestMemoryMaxDist 缺省取 HARVEST_MEMORY_MAX_DIST） | t1 t2 t3 t4 | harvestMemoryMine: 3 / harvestMemoryMaxDist: 2 |
| vanguard-prey-worker-v1 | vanguardPreyWorker=true | — | t1 t2 t3 t4 | vanguardPreyWorker: 3 |
| military-priority-v1 | threatMilitaryPriority=true | —（threatMilitaryFloor 缺省 4） | t2 t3 | threatMilitaryPriority: 2 / threatMilitaryFloor: 2 |
| threat-breakout-v1 | threatBreakout=true | — | — | threatBreakout: 2 |
| core-evade-v1 | coreEvade=true | — | t2 | coreEvade: 3 |
| core-evade-persist-v1 | coreEvade=true, coreEvadePersist=true | — | t2 | coreEvade: 3 / coreEvadePersist: 2 |
| core-evade-ttr-v1 | coreEvade=true, coreEvadeTtr=true, coreEvadePersist=true | — | t2 t3 t4 | coreEvade: 3 / coreEvadeTtr: 2 / coreEvadePersist: 2 |
| guard-axes-v1 | guardAxes=true | — | t1 t2 t3 t4 | guardAxes: 2 |
| guard-heal-rotation-v1 | guardHealRotation=true | — | t1 t2 | guardHealRotation: 2 |
| detached-squad-v1 | detachedSquadResponse=true | — | t1 t2 | detachedSquadResponse: 2 |
| bounded-raid-v1 | boundedRaid=true | — | — | boundedRaid: 2 |
| scout-evade-v1 | scoutEvade=true | — | t1 t2 t3 t4 | scoutEvade: 2 |
| ranger-memory-shot-v1 | rangerMemoryShot=true | — | — | rangerMemoryShot: 2 |
| military-frontier-scavenge-v1 | militaryScavengeFrontier=true | — | t1 t2 t3 | militaryScavengeFrontier: 2 |
| strike-core-v1 | aggression="aggressive" | attackForce=6, boundedRaid=true, rangerMemoryShot=true, strikeGroupReserve=true, militarySearchDense=true, militaryRingHoldTicks=20, enemyCoreMemoryTicks=1200, militaryHunt=true | t1 t2 t3 t4 | aggression: 4 / attackForce: 3 / boundedRaid: 2 / rangerMemoryShot: 2 / strikeGroupReserve: 2 / militarySearchDense: 2 / militaryRingHoldTicks: 2 / enemyCoreMemoryTicks: 2 / militaryHunt: 3 |
| population-ceiling-30-v1 | populationCeiling=30 | — | — | populationCeiling: 3 |
| population-ceiling-35-v1 | populationCeiling=35 | — | t1 t2 t3 t4 | populationCeiling: 3 |
| worker-mission-v1 | （空覆盖，safety 无开关） | — | t1 t2 t3 t4 | —（mission 见 §2；`\bmission\b` 全 src 16 文件词义过宽，属性访问 `.mission` 5 文件） |
| recovery-early-military-v1 | （空覆盖，safety 无开关） | — | t3 t4 | recoveryEarlyMilitary: 1（deterministic 侧） |
| lean-spend-v1 | （空覆盖，safety 无开关） | — | t2 | spawnReserve: 2（deterministic 侧） |

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

| id | flag | 参数 | 启用租户 | 代码读取 |
|----|------|------|----------|----------|
| strike-core-v1 | vanguardRatio=0.5, accumulateThreshold=30 | — | t1 t2 t3 t4 | vanguardRatio: 6 / accumulateThreshold: 6 |
| recovery-early-military-v1 | recoveryEarlyMilitary=true | — | t3 t4 | recoveryEarlyMilitary: 1 |
| vanguard-heavy-v1 | vanguardRatio=0.75 | — | t1 t3 t4 | vanguardRatio: 6 |
| worker-mission-v1 | mission（MissionConfig） | collectionValueFloor=-30, maxCollectionDistance=24, surveyWorkerCap=3, surveyBurstTicks=100, surveyWorkerFloor=3, visibleBonus=0.3, seedAgeDecay=0.02, refillLookahead=0, refillBonus=0, deadMineOverdueTicks=Infinity, migrationScout=true, switchThreshold=1.5, surveyOnSupplyGap=true | t1 t2 t3 t4 | `.mission` 属性访问 5 文件 |
| lean-spend-v1 | spawnReserve=1 | — | t2 | spawnReserve: 2 |

注册行号（抽查用）：strike-core-v1 L294、recovery-early-military-v1 L298、
vanguard-heavy-v1 L307、worker-mission-v1 L318、lean-spend-v1 L358。

## 3. 注册表外事实（现状漂移，已登记）

### 3.1 只存在于生产工作树注册表的 3 个孤儿变体

`coordinated-fire-v1`、`ranger-scavenge-v1`、`ranger-kite-v1` 注册在**生产工作树**
的注册表（`.worktrees/production-runtime/`、`.worktrees/production-runtime-v3/`、
`.worktrees/deploy-worker-ranger-v1/` 各自的
`packages/arena-agent/src/strategies/variant-registry.ts`），**main 工作树注册表
没有这三个 id**。

- 启用情况（实读 configs）：t1 启用全部 3 个；t2 启用 `coordinated-fire-v1` +
  `ranger-kite-v1`；t3/t4 未启用。
- 风险：在 main 工作树注册表上加载 t1/t2 的 variants 数组会 fail-fast
  （unknown safety variant）。生产跑的是生产工作树，故线上未炸——这是
  main 与生产注册表漂移的一部分（基线 60/226 漂移 + 孤儿变体，已登记）。

### 3.2 注册但无任何租户启用的变体（6 个）

`clear-path-v1`、`beacon-grab-v1`、`bounded-raid-v1`、`ranger-memory-shot-v1`、
`threat-breakout-v1`、`population-ceiling-30-v1`。

> 注：任务书 H 预期清单含 `core-evade-v1`，但实读 t2.json 的 variants 数组**包含**
> `core-evade-v1`（t2 同时启用 core-evade-persist-v1 / core-evade-ttr-v1），故
> core-evade-v1 不算"无租户启用"。本表以实读为准。

### 3.3 附注

- `population-ceiling-35-v1` 覆盖旧 `population-ceiling-30-v1`（注册表注释，
  2026-08-08 起全局调高）；30 上限已无租户启用。
- sim 侧 `sim/tools/planner-variants.ts` 复用本注册表构造 A/B 变体（注册表头部
  注释），离线实验与生产启用读同一份事实。
