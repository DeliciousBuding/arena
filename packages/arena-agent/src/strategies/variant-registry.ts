/**
 * 变体注册映射（生产侧，2026-08-06 架构整理）：候选变体 id → SafetyPlanner
 * 配置开关的单一映射。生产 config（runtime/configs/*.json）通过 `variants`
 * 字段声明启用（如 ["threat-recall-v1"]），运行时经本模块解析为 SafetyPlanner
 * 配置——"变体启用"从改代码布尔变成改配置声明；未知 id fail-fast。
 *
 * sim 侧注册表（sim/tools/planner-variants.ts）复用本映射构造 A/B 变体，
 * 保证离线实验与生产启用读同一份事实（无环：sim → strategies 已存在）。
 */

import type { SafetyPlannerConfig } from "./safety-planner.ts";

/** 候选变体 → SafetyPlanner 配置开关（全部默认 false 的历史行为零回归）。 */
export const VARIANT_SAFETY_CONFIG: Readonly<Record<string, Partial<SafetyPlannerConfig>>> =
  Object.freeze({
    "clear-path-v1": Object.freeze({ clearPath: true }),
    /**
     * 近核入侵观察（2026-08-08，core-threat-watch-v1）：敌单位距我方 Core
     * ≤18（Chebyshev）入长 TTL（60）观察——短记忆（6-12 tick）漏掉"盘踞/
     * 间歇可见"的近核敌情（t2 实证敌 WORKER 离核心 2 格盘踞 600+ tick，记忆
     * 过期后威胁归零、无军事响应）。观察内敌战斗单位 → 威胁 ALERT
     * （invasion_watch）+ 远端回援（reinforce-home-v1 同路径）；静止 WORKER
     * camp / 战斗单位 camp → 最近 Vanguard 回访清剿（vanguard_watch_clear）。
     */
    "core-threat-watch-v1": Object.freeze({ coreThreatWatch: true }),
    "threat-recall-v1": Object.freeze({ threatRecall: true }),
    /**
     * 远端军事回援（2026-08-07，竞品 "敌方战斗单位已经进入 Core 防区时，
     * 所有非守家单位跳过集结等待并立即回援" 对照）：可见敌方战斗单位进入
     * Core 防区（12）→ 远端 Vanguard/Ranger 立即回 Core 守位（优先于攻坚/
     * 打野/环搜），守家圈内单位走既有防御逻辑。与 threat-recall-v1 配套：
     * 一个管 worker 收缩守家圈，一个管远端军事回援。
     */
    "reinforce-home-v1": Object.freeze({ remoteReinforce: true }),
    /**
     * 信标夺取（2026-08-07，官方 Champion Beacon 机制对齐）：近距离
     * （Chebyshev ≤80）信标由最近 Vanguard 拾取并带回守家——持标核心盾
     * 上限 5→10 + worker 采集 1→2（双倍经济）。远距放弃（信标坐标公开，
     * 可能被敌方埋伏）。与 threat-recall/reinforce-home 同属防御经济层。
     */
    "beacon-grab-v1": Object.freeze({ beaconGrab: true, beaconGrabMaxDist: 80 }),
    "move-failed-avoidance-v1": Object.freeze({ moveFailedAvoidance: true }),
    /**
     * 威胁自适应防守（2026-08-07，排行榜威胁画像接入）：攻坚目标 owner 命中
     * 官方排行榜高伤害玩家（ELITE_AGGRESSOR=damage top10 / AGGRESSOR=top30）
     * 时"留强"——成型门槛 +2/+4（叠加 attackForce）+ 守家预留 1→2 Vanguard。
     * 高伤害玩家 = 猛攻蛆（用户裁决），进攻同时防偷家/反打。无画像/降级 =
     * 零回归。配套 external 数据源：docs/progress/leaderboard-intel.py 拉取
     * data/leaderboard/ 快照，运行时只读本地文件不联网。
     */
    "threat-adaptive-defense-v1": Object.freeze({ threatAdaptiveDefense: true }),
    /**
     * 严格占优攻坚（2026-08-07，guide v3.0 overmatch 对照）：按目标敌 Core
     * 实测守军（World.enemyCoreForces，Vanguard+Ranger 按 ID 去重）动态抬高
     * 攻坚成型门槛 = max(基础/威胁自适应, 守军估计+1)——存活兵力严格大于守军
     * 估计才压上；守军增援门槛同步抬高、兵力不足自动蓄势（vanguard_hold）。
     * 与 threat-adaptive-defense-v1 叠加：排行榜画像给先验，实测守军给实时。
     */
    "assault-overmatch-v1": Object.freeze({ assaultOvermatch: true }),
    /**
     * 攻坚集结（2026-08-08，guide "有护卫 Core 先退到安全集结点、全员到齐再共同
     * 出击"对照，t2 jerkman 二轮 5R 全灭实证）：aggressive 无可见敌人对已知敌 Core
     * 记忆攻坚时，军事单位先到敌核外圈安全集结位（Chebyshev 5，Vanguard 射程 1 /
     * Ranger 射程 3 之外）汇合，≥3 到齐或首到后 40 tick 超时再成建制压上——防逐个
     * 送死。与 assault-overmatch-v1 叠加：一个管"兵力够不够"，一个管"到齐再上"。
     */
    "rally-assault-v1": Object.freeze({ rallyAssault: true }),
    /**
     * 威胁方向侦察（2026-08-07，t2 生产实证）：worker 巡逻方位向已知敌核心
     * 方向（coreHuntTargets 首个 CORE）加权——前 4 worker 覆盖威胁扇区 ±1，
     * 保证威胁来路（如 t2 NE=jerkman）始终有 ≥3 worker 侦察，小股进攻更早
     * 目击 → 触发 ALERT/召回/迁移。无 CORE 目击 = 均匀分布零回归。
     */
    "threat-sector-scout-v1": Object.freeze({ threatSectorScout: true }),
    /**
     * 快攻防御（2026-08-07，raid-defense-v1）：威胁不能只看排行榜伤害——任何
     * 玩家都可能派小股部队来偷家（用户裁决"别人可以只派一些人来打"）。启用后：
     *  - 邻近敌核心（Chebyshev ≤24，coreHuntTargets CORE sticky）→ 恒留 ≥2
     *    Vanguard 守家（即使攻坚目标不是高威胁玩家，防小股偷家/换家）；
     *  - 实测敌军战斗单位（可见或 12 tick 记忆内）进入 18 格警戒圈 → 远端军事
     *    回援 + worker 召回半径从 12 放宽到 18（更早拦截，不等贴脸）。
     * 默认 false = 历史行为（仅 12 格确认接触 + 高威胁对手才留强，零回归）。
     */
    "raid-defense-v1": Object.freeze({ raidDefense: true }),
    /**
     * 核心通道清障（2026-08-07，core-clearance-v1）：核心格容量 2（含 Core）
     * 且是 worker 卸货唯一通道——军事守位回退到核心格 = 卸货死锁（生产 t2
     * 实证：Vanguard 占核心格 → 满载 worker 4 邻格全 WAIT、DEPOSIT_FAILED
     * 77%，手操移开下 tick 又被放回）。启用后军事绝不站核心格（守位回退外圈
     * Chebyshev 2）、已在核心格的军事/满载 worker 自动疏散让位。默认 false。
     */
    "core-clearance-v1": Object.freeze({ coreClearance: true }),
    /**
     * worker 密集扫图（2026-08-07，worker-dense-scan-v1）：worker 巡逻 8→16
     * 方位（DENSE_DELTAS），相邻方位间距减半——资源稀缺时盲区大（生产实测
     * avgVisible 0.5-0.6 格/tick，8 方位在半径 24 处相邻 ~18 格 > 视野 3×2）。
     * 默认 false = 历史 8 方位（零回归）。离线 A/B 出证据后再决定是否启用。
     */
    "worker-dense-scan-v1": Object.freeze({ workerDenseScan: true }),
    /**
     * frontier 老化优先巡（2026-08-07，frontier+dense 组合候选，resource-scarcity-ab
     * 复核）：worker 回 home 换方位时按 chunk 观察老化选方向——观察最老的分区先巡。
     * 与 worker-dense-scan-v1 组合最稳（任何场景不劣于 baseline，生产形态 +20%）：
     * dense 单开稀疏 +20% 但对角远矿 -14%（worker 摊薄），frontier 补老分区后中和。
     * 默认 false = 固定 +3/+6 方位步进（零回归）。
     */
    "frontier-priority-v1": Object.freeze({ frontierPriority: true }),
    /**
     * 前锋重装（2026-08-08，vanguard-heavy-v1）：只影响 deterministic 侧
     * 产兵配比（vanguardRatio 0.75，见 DETERMINISTIC_VARIANT_CONFIG），
     * safety 侧无开关——空覆盖注册以满足 resolveVariantsConfig 的
     * 全量 safety 校验（缺注册 = 生产重启 fail-fast）。
     */
    "vanguard-heavy-v1": Object.freeze({}),
    /**
     * 核心迁移中交仓待命（2026-08-07，core-moving-hold-v1）：Core MOVING 时
     * （START_MOVE 迁移中，引擎拒 DEPOSIT——CORE_MOVING/CORE_NOT_PRESENT），
     * cargo worker 原地持货等核心稳定，不追着移动核心空跑（生产实测 t2/t3
     * 手操迁移时 150 tick 内 DEPOSIT_FAILED 17/11 次）。与 core-clearance-v1
     * 互补：一个管迁移中不追交、一个管不堵核心格。
     * 默认 false = 历史行为（迁移中也追交，零回归）。
     */
    "core-moving-hold-v1": Object.freeze({ coreMovingHold: true }),
    /**
     * 记忆矿主动开采（2026-08-08，harvest-memory-mine-v1，survey-db 联动）：
     * 无可见资源且无活跃采集目标时从已知矿记忆（含跨 run 测绘 seed）挑最近
     * 的去挖——"矿发现了没标注/没分配去挖"的算法端闭环。默认 false 零回归。
     */
    "harvest-memory-mine-v1": Object.freeze({ harvestMemoryMine: true }),
    /**
     * 清剿可见敌方 WORKER（2026-08-08，用户"挂机/落单单位赶紧打掉"）：
     * aggressive Vanguard 对 12 格内可见敌 WORKER 优先追击（白赚：断经济 +
     * 无反击），避开敌核心守军 8 格；只最近 1 个去（防扎堆）。默认 false 零回归。
     */
    "vanguard-prey-worker-v1": Object.freeze({ vanguardPreyWorker: true }),
    /**
     * 威胁优先产兵（2026-08-08，military-priority-v1）：活跃敌核贴脸
     * （raid-defense nearbyEnemyCore ≤24 格，coreHuntTargets CORE sticky）且
     * 军事规模 < 地板（threatMilitaryFloor 默认 4）→ 跳过 worker 积累直接产兵
     * + 用低储备（reserveEarly=1）尽早成型——reference guide"敌方进入 Core
     * 防区 → 守家队优先补齐"（t3 实证 3 活跃敌核 ≤20 格仅 1 Vanguard，res 11
     * 被财富储备 3 卡到 13）。默认 false = 历史行为（worker→军事顺序零回归）。
     */
    "military-priority-v1": Object.freeze({ threatMilitaryPriority: true }),
    "threat-breakout-v1": Object.freeze({ threatBreakout: true }),
    "core-evade-v1": Object.freeze({ coreEvade: true }),
    "core-evade-persist-v1": Object.freeze({ coreEvade: true, coreEvadePersist: true }),
    /**
     * TTR 预撤离（2026-08-07，竞品 time-to-range 对照）：敌人位置差分估算
     * 逼近速度，TTR（到射程时间）≤16 tick 即触发迁移——比 12 格固定阈值
     * 更早（高速逼近的敌人在 20 格外 TTR 已 ≤16）。小股快攻更早预警。
     */
    "core-evade-ttr-v1": Object.freeze({ coreEvade: true, coreEvadeTtr: true, coreEvadePersist: true }),
    "guard-axes-v1": Object.freeze({ guardAxes: true }),
    "guard-heal-rotation-v1": Object.freeze({ guardHealRotation: true }),
    "detached-squad-v1": Object.freeze({ detachedSquadResponse: true }),
    "bounded-raid-v1": Object.freeze({ boundedRaid: true }),
    "scout-evade-v1": Object.freeze({ scoutEvade: true }),
    "ranger-memory-shot-v1": Object.freeze({ rangerMemoryShot: true }),
    /**
     * 攻坚候选（2026-08-07 用户导向"爆兵打对面水晶"，安全侧 = 军事单位行为）：
     * - aggression=aggressive：Vanguard 记忆推进敌 Core / Ranger 断敌经济；
     * - attackForce=6：军事规模达标才前压（避免零星送死）；
     * - boundedRaid：敌 Core 超 40 格视为远征送死，回撤守家；
     * - rangerMemoryShot：视野丢失时对记忆中的敌 Core 格保持射击压制；
     * - strikeGroupReserve：留 1 个 Vanguard 守家（防换家）。
     * 配套 deterministic 侧（DETERMINISTIC_VARIANT_CONFIG）：vanguardRatio=0.5
     * 交替产兵 + accumulateThreshold=30 积累期爆兵节奏。
     */
    "strike-core-v1": Object.freeze({
      aggression: "aggressive",
      attackForce: 6,
      boundedRaid: true,
      rangerMemoryShot: true,
      strikeGroupReserve: true,
      // 攻坚搜索补强（2026-08-07）：16 方位密集搜索（覆盖 off-diagonal 敌 Core
      // 几何盲区——8 方位最近 Manhattan 7 > 视野 4）+ 同环 20 tick 时间预算强制
      // 升环（破"争格/振荡永不外扩"）+ 敌 Core 记忆窗口 1200（发现即长时前压）。
      militarySearchDense: true,
      militaryRingHoldTicks: 20,
      enemyCoreMemoryTicks: 1200,
      // 敌情狩猎（2026-08-07，持久敌情测绘）：无可见敌人/资源时优先回访最后
      // 已知敌基地（CORE 目击 sticky + Worker 轨迹推断）并清扫，替代 home 盲搜
      // ——t1 生产实证：敌 Core 迁移后军队在旧位置空转、环搜几何近失永不接敌。
      militaryHunt: true,
    }),
    /**
     * 人口上限 20→30（2026-08-08 用户裁决，t1 恢复综合扩张）：populationCeiling
     * 是产兵硬门（deterministic selectDeterministicCoreAction 与 SafetyPlanner
     * 共用）——t1 pop 25 时 20 上限导致 4500+ tick 零产兵、res 顶到容量上限
     * （pop×5=120）空转。30 = v0.14 动态定价 k=2 档末（pop 26-30：Vanguard 17/
     * Ranger 20；31 起 k=3 跳 22+），继续扩张但不过度进入高溢价档。仅 t1 启用。
     */
    "population-ceiling-30-v1": Object.freeze({ populationCeiling: 30 }),
  });

/** DeterministicPlanner 构造参数覆盖（core 生产侧，2026-08-07）：变体同时需要
 *  影响"产什么兵"（vanguardRatio/accumulateThreshold/spawnReserve）时注册到这里。
 *  与 VARIANT_SAFETY_CONFIG 同 id 配对——"变体启用 = 配置声明"在 deterministic
 *  模式同样成立（tenant-runtime 把两部分都喂给对应构造器）。 */
export interface DeterministicVariantConfig {
  /** VANGUARD 目标占比 [0,1]（缺省 undefined = 交替产兵，历史行为）。 */
  readonly vanguardRatio?: number;
  /** 爆兵阈值：resources 达标前只产 Worker 积累、达标后全力爆兵（0 = 关闭）。 */
  readonly accumulateThreshold?: number;
  /** 补员 reserve（缺省 2 = 生产行为零回归）。 */
  readonly spawnReserve?: number;
}

export const DETERMINISTIC_VARIANT_CONFIG: Readonly<Record<string, DeterministicVariantConfig>> =
  Object.freeze({
    "strike-core-v1": Object.freeze({ vanguardRatio: 0.5, accumulateThreshold: 30 }),
    /**
     * 前锋重装（2026-08-08，用户裁决"多生产前锋"）：vanguardRatio 0.5→0.75——
     * 军事单位 3/4 为 Vanguard（攻坚拆家/守家前排），Ranger 保留 1/4 远程压制。
     * military-composition-experiment（v0.11）：防守对手 Vanguard 配比越高越优
     * （1.0:+35 / 0.5:+33）；进攻对手 Vanguard 前压被集火（全 Ranger 存活）——
     * 0.75 是"偏前锋但不裸奔"折中。与 strike-core-v1 叠加：仅调配比，保留
     * accumulateThreshold=30 爆兵节奏。
     */
    "vanguard-heavy-v1": Object.freeze({ vanguardRatio: 0.75 }),
  });

/** 解析变体 id → SafetyPlanner 配置覆盖；未知 id 抛错（fail-fast）。 */
export function resolveSafetyVariantConfig(id: string): Partial<SafetyPlannerConfig> {
  const config = VARIANT_SAFETY_CONFIG[id];
  if (config === undefined) {
    throw new Error(
      `unknown safety variant: ${id} (registered: ${Object.keys(VARIANT_SAFETY_CONFIG).join(", ")})`,
    );
  }
  return config;
}

/** 解析变体 id → DeterministicPlanner 参数覆盖。变体 id 的合法性统一由
 *  resolveSafetyVariantConfig 负责（所有生产变体都注册在安全侧）；这里对
 *  没有 deterministic 部分（如 move-failed-avoidance-v1）的变体返回 {} =
 *  零覆盖，不抛错（"无 deterministic 声明 = 不影响 core 生产"是正确语义）。 */
export function resolveDeterministicVariantConfig(id: string): DeterministicVariantConfig {
  return DETERMINISTIC_VARIANT_CONFIG[id] ?? {};
}

/** 判断 id 是否为已注册的安全变体（config schema 校验用）。 */
export function isSafetyVariant(id: string): boolean {
  return id in VARIANT_SAFETY_CONFIG;
}

/** 解析 config.variants 列表 → 合并的 SafetyPlanner 配置覆盖（缺省/空 = 零覆盖）。 */
export function resolveVariantsConfig(
  ids: readonly string[] | undefined,
): Partial<SafetyPlannerConfig> {
  if (ids === undefined || ids.length === 0) return {};
  return Object.assign({}, ...ids.map((id) => resolveSafetyVariantConfig(id)));
}

/** 解析 config.variants 列表 → 合并的 DeterministicPlanner 参数覆盖（缺省/空 = 零覆盖）。 */
export function resolveDeterministicVariantsConfig(
  ids: readonly string[] | undefined,
): DeterministicVariantConfig {
  if (ids === undefined || ids.length === 0) return {};
  return Object.assign({}, ...ids.map((id) => resolveDeterministicVariantConfig(id)));
}


