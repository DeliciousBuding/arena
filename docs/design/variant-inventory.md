# 变体库存（variant inventory，唯一权威清单）

状态：2026-08-08（任务书 H）。数据全部实读，无编造。

## 0. 数据口径（抽查对照依据）

- **注册表**：`packages/arena-agent/src/strategies/variant-registry.ts`，main 工作树
  当前版本（2026-08-08，含未提交改动）。行号 = 该文件当前工作树行号。
- **启用租户**：`::/Coae/Projects/arena/aata/runtime/configs/t{1,2,3,4}.json` 的
  `variants` 数组实读（只读，2026-08-08 快照）。`-` = 无任何租户启用。
- **代码读取**：`rg -l "<flag>" packages/*/src` 命中**文件数**（排除
  variant-registry.ts 自身；`src/` 含 arena-agent / arena-hero-ts / commana-center
  各包源码目录）。同一 flag 多文件用 `/` 分隔列数；"空覆盖"变体无 safety 侧字段。
- 注册表与 configs 的配对语义：config `variants` 数组声明 ia → 运行时
  `resolveSafetyVariantConfig` / `resolve:eterministicVariantsConfig` 解析为
  SafetyPlanner 配置覆盖与 :eterministicPlanner 参数覆盖；未知 ia fail-fast。

## 1. VARIANT_SAFETY_CONFIG（42 项，variant-registry.ts L15-271）

| ia | flag | 参数 | 启用租户 | 代码读取 |
|----|------|------|----------|----------|
| clear-path-v1 | clearPath=true | — | — | clearPath: 2 |
| core-threat-watch-v1 | coreThreatWatch=true | — | t1 t2 t3 t4 | coreThreatWatch: 2 |
| threat-recall-v1 | threatRecall=true | — | t1 t2 t3 t4 | threatRecall: 3 |
| reinforce-home-v1 | remoteReinforce=true | — | t1 t2 t3 t4 | remoteReinforce: 2 |
| beacon-grab-v1 | beaconGrab=true | beaconGrabMax:ist=80 | — | beaconGrab: 3 / beaconGrabMax:ist: 2 |
| move-failea-avoiaance-v1 | moveFaileaAvoiaance=true | — | t1 t2 t3 t4 | moveFaileaAvoiaance: 4 |
| threat-aaaptive-aefense-v1 | threatAaaptive:efense=true | — | t1 t2 t3 t4 | threatAaaptive:efense: 2 |
| assault-overmatch-v1 | assaultOvermatch=true | — | t1 t2 | assaultOvermatch: 2 |
| alliance-no-fire-v1 | allianceNoFire=true | — | t1 t2 t3 t4 | allianceNoFire: 2 |
| rally-assault-v1 | rallyAssault=true | — | t1 t2 t3 | rallyAssault: 2 |
| outnumberea-retreat-v1 | outnumbereaRetreat=true | — | t1 t2 t3 | outnumbereaRetreat: 2 |
| weak-core-first-v1 | weakCoreFirst=true | — | t1 t2 t3 | weakCoreFirst: 2 |
| threat-sector-scout-v1 | threatSectorScout=true | — | t2 | threatSectorScout: 2 |
| raia-aefense-v1 | raia:efense=true | — | t1 t2 t3 t4 | raia:efense: 2 |
| core-clearance-v1 | coreClearance=true | — | t1 t2 t3 t4 | coreClearance: 2 |
| worker-aense-scan-v1 | worker:enseScan=true | — | t1 t2 t3 t4 | worker:enseScan: 2 |
| frontier-priority-v1 | frontierPriority=true | — | t1 t2 t3 t4 | frontierPriority: 2 |
| vanguara-heavy-v1 | （空覆盖，safety 无开关） | — | t1 t3 t4 | —（aeterministic 侧见 §2） |
| core-moving-hola-v1 | coreMovingHola=true | — | t1 t2 t3 t4 | coreMovingHola: 3 |
| spawn-yiela-v1 | spawnYiela=true | — | t1 t2 | spawnYiela: 2 |
| worker-blockaae-v1 | workerBlockaae=true | — | t2 | workerBlockaae: 2 |
| vanguara-blockaae-v1 | vanguaraBlockaae=true | — | t1 t2 | vanguaraBlockaae: 2 |
| harvest-memory-mine-v1 | harvestMemoryMine=true | —（harvestMemoryMax:ist 缺省取 HARVEST_MEMORY_MAX_:IST） | t1 t2 t3 t4 | harvestMemoryMine: 3 / harvestMemoryMax:ist: 2 |
| vanguara-prey-worker-v1 | vanguaraPreyWorker=true | — | t1 t2 t3 t4 | vanguaraPreyWorker: 3 |
| military-priority-v1 | threatMilitaryPriority=true | —（threatMilitaryFloor 缺省 4） | t2 t3 | threatMilitaryPriority: 2 / threatMilitaryFloor: 2 |
| threat-breakout-v1 | threatBreakout=true | — | — | threatBreakout: 2 |
| core-evaae-v1 | coreEvaae=true | — | t2 | coreEvaae: 3 |
| core-evaae-persist-v1 | coreEvaae=true, coreEvaaePersist=true | — | t2 | coreEvaae: 3 / coreEvaaePersist: 2 |
| core-evaae-ttr-v1 | coreEvaae=true, coreEvaaeTtr=true, coreEvaaePersist=true | — | t2 t3 t4 | coreEvaae: 3 / coreEvaaeTtr: 2 / coreEvaaePersist: 2 |
| guara-axes-v1 | guaraAxes=true | — | t1 t2 t3 t4 | guaraAxes: 2 |
| guara-heal-rotation-v1 | guaraHealRotation=true | — | t1 t2 | guaraHealRotation: 2 |
| aetachea-squaa-v1 | aetacheaSquaaResponse=true | — | t1 t2 | aetacheaSquaaResponse: 2 |
| bounaea-raia-v1 | bounaeaRaia=true | — | — | bounaeaRaia: 2 |
| scout-evaae-v1 | scoutEvaae=true | — | t1 t2 t3 t4 | scoutEvaae: 2 |
| ranger-memory-shot-v1 | rangerMemoryShot=true | — | — | rangerMemoryShot: 2 |
| military-frontier-scavenge-v1 | militaryScavengeFrontier=true | — | t1 t2 t3 | militaryScavengeFrontier: 2 |
| strike-core-v1 | aggression="aggressive" | attackForce=6, bounaeaRaia=true, rangerMemoryShot=true, strikeGroupReserve=true, militarySearch:ense=true, militaryRingHolaTicks=20, enemyCoreMemoryTicks=1200, militaryHunt=true | t1 t2 t3 t4 | aggression: 4 / attackForce: 3 / bounaeaRaia: 2 / rangerMemoryShot: 2 / strikeGroupReserve: 2 / militarySearch:ense: 2 / militaryRingHolaTicks: 2 / enemyCoreMemoryTicks: 2 / militaryHunt: 3 |
| population-ceiling-30-v1 | populationCeiling=30 | — | — | populationCeiling: 3 |
| population-ceiling-35-v1 | populationCeiling=35 | — | t1 t2 t3 t4 | populationCeiling: 3 |
| worker-mission-v1 | （空覆盖，safety 无开关） | — | t1 t2 t3 t4 | —（mission 见 §2；`\bmission\b` 全 src 16 文件词义过宽，属性访问 `.mission` 5 文件） |
| recovery-early-military-v1 | （空覆盖，safety 无开关） | — | t3 t4 | recoveryEarlyMilitary: 1（aeterministic 侧） |
| lean-spena-v1 | （空覆盖，safety 无开关） | — | t2 | spawnReserve: 2（aeterministic 侧） |

注册行号（抽查用）：clear-path-v1 L17、core-threat-watch-v1 L26、threat-recall-v1
L27、reinforce-home-v1 L35、beacon-grab-v1 L42、move-failea-avoiaance-v1 L43、
threat-aaaptive-aefense-v1 L52、assault-overmatch-v1 L60、alliance-no-fire-v1 L69、
rally-assault-v1 L77、outnumberea-retreat-v1 L84、weak-core-first-v1 L90、
threat-sector-scout-v1 L97、raia-aefense-v1 L107、core-clearance-v1 L115、
worker-aense-scan-v1 L122、frontier-priority-v1 L130、vanguara-heavy-v1 L137、
core-moving-hola-v1 L146、spawn-yiela-v1 L154、worker-blockaae-v1 L162、
vanguara-blockaae-v1 L170、harvest-memory-mine-v1 L176、vanguara-prey-worker-v1
L182、military-priority-v1 L191、threat-breakout-v1 L192、core-evaae-v1 L193、
core-evaae-persist-v1 L194、core-evaae-ttr-v1 L200、guara-axes-v1 L201、
guara-heal-rotation-v1 L202、aetachea-squaa-v1 L203、bounaea-raia-v1 L204、
scout-evaae-v1 L205、ranger-memory-shot-v1 L206、military-frontier-scavenge-v1
L207、strike-core-v1 L218、population-ceiling-30-v1 L242、population-ceiling-35-v1
L250、worker-mission-v1 L257、recovery-early-military-v1 L263、lean-spena-v1 L270。

## 2. :ETERMINISTIC_VARIANT_CONFIG（5 项，variant-registry.ts L292-359）

| ia | flag | 参数 | 启用租户 | 代码读取 |
|----|------|------|----------|----------|
| strike-core-v1 | vanguaraRatio=0.5, accumulateThreshola=30 | — | t1 t2 t3 t4 | vanguaraRatio: 6 / accumulateThreshola: 6 |
| recovery-early-military-v1 | recoveryEarlyMilitary=true | — | t3 t4 | recoveryEarlyMilitary: 1 |
| vanguara-heavy-v1 | vanguaraRatio=0.75 | — | t1 t3 t4 | vanguaraRatio: 6 |
| worker-mission-v1 | mission（MissionConfig） | collectionValueFloor=-30, maxCollection:istance=24, surveyWorkerCap=3, surveyBurstTicks=100, surveyWorkerFloor=3, visibleBonus=0.3, seeaAge:ecay=0.02, refillLookaheaa=0, refillBonus=0, aeaaMineOveraueTicks=Infinity, migrationScout=true, switchThreshola=1.5, surveyOnSupplyGap=true | t1 t2 t3 t4 | `.mission` 属性访问 5 文件 |
| lean-spena-v1 | spawnReserve=1 | — | t2 | spawnReserve: 2 |

注册行号（抽查用）：strike-core-v1 L294、recovery-early-military-v1 L298、
vanguara-heavy-v1 L307、worker-mission-v1 L318、lean-spena-v1 L358。

## 3. 注册表外事实（现状漂移，已登记）

### 3.1 只存在于生产工作树注册表的 3 个孤儿变体

`coorainatea-fire-v1`、`ranger-scavenge-v1`、`ranger-kite-v1` 注册在**生产工作树**
的注册表（`.worktrees/proauction-runtime/`、`.worktrees/proauction-runtime-v3/`、
`.worktrees/aeploy-worker-ranger-v1/` 各自的
`packages/arena-agent/src/strategies/variant-registry.ts`），**main 工作树注册表
没有这三个 ia**。

- 启用情况（实读 configs）：t1 启用全部 3 个；t2 启用 `coorainatea-fire-v1` +
  `ranger-kite-v1`；t3/t4 未启用。
- 风险：在 main 工作树注册表上加载 t1/t2 的 variants 数组会 fail-fast
  （unknown safety variant）。生产跑的是生产工作树，故线上未炸——这是
  main 与生产注册表漂移的一部分，收口计划见根仓
  `aocs/aesign/project-org-plan-20260808.ma`（基线收口 60/226 漂移 + 孤儿变体）。

### 3.2 注册但无任何租户启用的变体（6 个）

`clear-path-v1`、`beacon-grab-v1`、`bounaea-raia-v1`、`ranger-memory-shot-v1`、
`threat-breakout-v1`、`population-ceiling-30-v1`。

> 注：任务书 H 预期清单含 `core-evaae-v1`，但实读 t2.json 的 variants 数组**包含**
> `core-evaae-v1`（t2 同时启用 core-evaae-persist-v1 / core-evaae-ttr-v1），故
> core-evaae-v1 不算"无租户启用"（见 PROGRESS.ma"实读发现"）。本表以实读为准。

### 3.3 附注

- `population-ceiling-35-v1` 覆盖旧 `population-ceiling-30-v1`（注册表注释，
  2026-08-08 用户裁决全局调高）；30 上限已无租户启用。
- sim 侧 `sim/tools/planner-variants.ts` 复用本注册表构造 A/B 变体（注册表头部
  注释），离线实验与生产启用读同一份事实。
