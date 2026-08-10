import {
  cellKey,
  type CoreAction,
  type Direction,
  type Plan,
  type Position,
  type TickState,
  type UnitAction,
  type UnitSnapshot,
  type UnitType,
  type VisibleEntity,
} from "../domain/model.ts";
import {
  chebyshev,
  directionToAdjacent,
  EXPLORE_DIRECTION_COUNT,
  EXPLORE_RING_COUNT,
  exploreRadiusForRing,
  exploreTarget,
  hungerGateActive,
  lineBlocked,
  manhattan,
  move,
  nearest,
  stepToward,
} from "../domain/nav.ts";
import { UNIT_MAX_HP } from "../domain/plan-validator.ts";
import { countEnemiesNearCore } from "../domain/plan-validator.ts";
import { PhaseMachine } from "../domain/phase-machine.ts";
import { type CoreHuntTarget, visionLineBlocked, World } from "../domain/world.ts";
import type { MigrationPlanV1 } from "../migration/plan.ts";
import {
  assessThreat,
  advanceRecentAttack,
  squadContactThisTick,
  coreDamagedThisTick,
  projectedDamageOnCore,
  type ThreatAssessment,
} from "../domain/threat.ts";
import { RAID_CORE_RADIUS, RAID_SIGHTING_FRESH_TICKS, RAID_UNIT_WATCH_RADIUS } from "../domain/raid-risk.ts";
import { aggressionOf, type MacroPolicy } from "../runtime/macro-policy.ts";
import {
  DEFAULT_SAFETY_CONFIG,
  WIDE_EXPLORE_DEFAULTS,
  type AggressionLevel,
  type SafetyPlannerConfig,
  type ThreatProfile,
  type ThreatTier,
} from "./safety-planner-config.ts";
import {
  EMPTY_SQUAD_MEMBERSHIP,
  rallyMemberSlot,
  rallyPointAtMemberSlot,
  reconcileTacticalSquads,
  type SquadMembership,
  type SquadUnit,
  type TacticalSquad,
  type TacticalSquadRole,
} from "./tactical-squads.ts";
import {
  aggressiveShotPriority,
  canShoot,
  defensePost,
  defensiveShotPriority,
  homeCell,
  kiteCell,
  nearestEnemy,
  nextMilitary,
  nextSpawn,
  occupancyCounts,
  parseCell,
  predictedEnemyCell,
  retreatDirection,
  samePosition,
  terrainGuardPost,
  coreShelterTarget,
  isCoreShelter,
  yieldAnchor,
  guardHomeCell,
} from "./safety-planner-helpers.ts";
import { EMPTY_ROSTER_ID_SET, type AllianceRosterRef } from "../alliance/roster-file.ts";
import { unitSpawnCost } from "../domain/pricing.ts";
import {
  chokepointLockPoint,
  enemyReturnPath,
  pairBlockadeTargets,
} from "./blockade-predict.ts";
import {
  type RefillPrediction,
  planChunkResurvey,
} from "../intel/refill-predictions.ts";

export { AGGRESSIVE_SAFETY_CONFIG, DEFAULT_SAFETY_CONFIG } from "./safety-planner-config.ts";
export type { AggressionLevel, SafetyPlannerConfig } from "./safety-planner-config.ts";
export { directionName } from "./safety-planner-helpers.ts";

/** 密集军事搜索 16 方位（2026-08-07）：8 方位 + 半八分位（整数格近似）。
 *  顺时针（y 向南）：0=E 1=ESE 2=SE 3=SSE 4=S 5=SSW 6=SW 7=WSW
 *  8=W 9=WNW 10=NW 11=NNW 12=N 13=NNE 14=NE 15=ENE。
 *  [1,-2]（NNE，-63.4°）是 t1 敌 Core 方向（[-611,-169] vs home
 *  [-619,-154] = -61.9°）——8 方位没有该角，最近 NE 线 Manhattan 7 超出
 *  视野 4；16 方位 [1,-2] 距 Core Manhattan ~1 进入视野。 */
const DENSE_DELTAS: readonly Position[] = [
  [1, 0], [2, 1], [1, 1], [1, 2],
  [0, 1], [-1, 2], [-1, 1], [-2, 1],
  [-1, 0], [-2, -1], [-1, -1], [-1, -2],
  [0, -1], [1, -2], [1, -1], [2, -1],
] as const;

/** 密集方位目标点（16 方向 × 半径，锚定 beacon 方位旋转）。 */
function exploreTargetDense(
  home: Position,
  beacon: Position,
  directionIndex: number,
  radius: number,
): Position {
  const dx = beacon[0] - home[0];
  const dy = beacon[1] - home[1];
  const base = Math.round(Math.atan2(dy, dx) / (Math.PI / 8) / 2) * 2 % 16;
  const norm = ((base + directionIndex) % 16 + 16) % 16;
  const [mx, my] = DENSE_DELTAS[norm]!;
  return [home[0] + mx * radius, home[1] + my * radius];
}
/** 威胁方向加权巡逻方位（threat-sector-scout-v1，2026-08-07，纯函数可测）：
 * 前 4 个 worker 覆盖威胁扇区及两侧（index0=威胁方向, +1, -1, +2），其余保持
 * 均匀分布——保证威胁来路（如 t2 NE=jerkman）始终有 ≥3 worker 侦察，小股
 * 进攻更早目击触发预警。threatSector=null 返回历史均匀方位（零回归）。 */
export function threatWeightedDirection(
  index: number,
  threatSector: number | null,
): number {
  const spread = (index * 3 + 7) % EXPLORE_DIRECTION_COUNT;
  if (threatSector === null) return spread;
  if (index < 4) {
    const offset = index === 0 ? 0 : index === 1 ? 1 : index === 2 ? -1 : 2;
    return (threatSector + offset + EXPLORE_DIRECTION_COUNT) % EXPLORE_DIRECTION_COUNT;
  }
  return spread;
}

/** 威胁召回触发距离（12 = ALERT 级威胁的确认接触半径，与 threat.ts 一致）。 */
const THREAT_RECALL_DISTANCE = 12;
/** 召回时 worker 的守家巡逻半径。 */
const RECALL_PATROL_RADIUS = 4;
/** 记忆矿开采距离上限（Manhattan，默认 40 = 探索最外环）：防追 70+ 格远矿。 */
const HARVEST_MEMORY_MAX_DIST = 40;
/** 记忆矿追猎新鲜度窗口（魂）：见 harvestMemoryFreshTicks。 */
const HARVEST_MEMORY_FRESH_TICKS = 64;
/** 记忆矿采集槽（2026-08-08 生产吞吐修复）：自然资源节点每 tick 只允许一个
 *  HARVEST winner；格子实体容量=2 只是移动容量，不代表采集吞吐=2。记忆矿因此
 *  必须一矿一 Worker，避免第二个 Worker 长期 capacity_wait/到点后必败。 */
const HARVEST_MEM_TARGET_SLOTS = 1;
/** 巡逻出发错峰（2026-08-08，t2 生产实证）：核心区 worker 群同步出发 → 出口容量
 *  互堵永久卡死（12 worker 挤核心 5 格 36+ tick 位置不动，capacity_reroute 无
 *  空格可绕）。判定半径（Chebyshev 离 home）与拥挤阈值（manhattan ≤2 内 worker）。 */
const PATROL_DEPARTURE_RADIUS = 3;
const PATROL_DEPARTURE_CROWD = 5;
/** 记忆矿卡死回退阈值（2026-08-08，t3 生产实证）：go_harvest_mem 连续 N tick
 *  未推进（容量争抢/路径被堵，非 patrol intent 无法 capacity_reroute）→ 清空
 *  目标回退巡逻，防永久 WAIT 死锁。 */
const HARVEST_MEM_STUCK_TICKS = 8;
/** Core 迁移 TTR 预撤离阈值（竞品 time-to-range ≤16 tick）。 */
const TTR_PRE_EVADE_TICKS = 16;
/** B9 迁移取消冷却（coreMigrationCancel）：取消后 N tick 内不重触发 START_MOVE。 */
const CORE_MIGRATION_CANCEL_COOLDOWN = 10;
/**
 * ranger_memory_shot 记忆新鲜度上限（2026-08-10 修复）：记忆射击只打"短暂
 * 视野丢失"的静止敌核——死核/迁移核/重生核的旧格记忆对空枪（t1 生产实证
 * 338 次 SHOT_MISSED）。strike-core-v1 把 enemyCoreMemoryTicks 提到 1200，
 * 记忆射击不该继承攻坚记忆窗口（攻坚打记忆格有 Vanguard 协同，记忆射击是
 * 纯猜格）。min 收窄到 60 = 原默认值，覆盖"短视野丢失"语义，堵死核残留放大。
 */
const RANGER_MEMORY_SHOT_MAX_AGE = 60;
const RANGER_DIRECT_SHOT_MISS_LIMIT = 3;
/** 守卫轮换治疗（B8 候选）：HP ≤ 该值即回 Core 补血（掉血过半）。 */
const HEAL_ROTATION_HP: Record<UnitType, number> = { WORKER: 1, VANGUARD: 2, RANGER: 1 };
/** 守卫"战斗中不回修"的反击范围（敌进入守卫反击射程 = 战斗压力，带伤值守）。 */
const HEAL_ROTATION_ENGAGE_RANGE: Record<UnitType, number> = { WORKER: 1, VANGUARD: 1, RANGER: 3 };
/** B8 守卫轮换 one-at-a-time（竞品 "one wounded defender at a time"）：
 *  触发回修后该守卫占用回修名额的 tick 窗口（路上 + 补血）。 */
const HEAL_ROTATION_HOLD_TICKS = 12;
/** W57 relief 相默认冷却 tick（双相 FSM）：前伤员脱离危险血量后槽冷却的最短
 *  时间——给前伤员在 Core 格继续补满/让位移动的时间，阻止下一个伤员立即冲入
 *  仍被占用的 Core 格造成 capacity 互堵。4 覆盖常见 HEAL 1-2 tick + 让位 1-2 tick。 */
const HEAL_ROTATION_RELIEF_TICKS = 4;
/** B5 远端突击组局部响应（竞品 detached squad）：敌非目标单位进入 5 格 = 被拦截。 */
const DETACHED_RESPONSE_RADIUS = 5;
/** 被拦截后回 Core 守位的最少 tick（竞品 "at least eight Ticks"）。 */
const DETACHED_RETURN_TICKS = 8;
/** 远端军事回援保持窗口（remoteReinforce 候选，竞品 "敌方战斗单位已经进入
 *  Core 防区时，所有非守家单位跳过集结等待并立即回援"）：触发回援后即使敌
 *  人闪失（离开 12 格防区），8 tick 内仍继续回 Core——防"敌进 12 → 军事掉头
 *  → 敌退 12 → 军事折返"的抖动（与 B5 detachedReturn 同 8-tick 语义）。 */
const REINFORCE_HOLD_TICKS = 8;
/** 守家圈半径（Chebyshev/Manhattan 口径统一用 Manhattan，与 threatRecall 同）：
 *  距 Core ≤4 视为守家队（Vanguard 3 格外层屏 / Ranger 2 格内层屏），回援
 *  只针对圈外远端军事——圈内单位走既有防御逻辑（不打断正在进行的防守）。 */
const REINFORCE_HOME_RING = 4;
/** 信标夺取默认最大距离（Chebyshev，以我方 Core 为圆心）：官方信标坐标全员
 *  公开，超出视为远征——信标所在区域可能被敌方埋伏（远距公敌），不值得送死。 */
/** 信标夺取安全距离（2026-08-08 对齐 ref guide"冠军信标远征机制已经取消"、
 *  arena-hero-agent LOCKED_BEACON_POLICY=retreat）：默认只在核心 24 格防区内
 *  机会取标（2× 采集 + 盾 10），之外一律撤退不接近——远距取标 = 单骑深入
 *  敌区送死（t2 实证：信标 51 格北侧，疑似 jerkman 停靠）。生产 config 已
 *  停用 beacon-grab-v1；此默认保证未来重启用也安全。 */
const BEACON_GRAB_DEFAULT_MAX_DIST = 24;
/** 信标争夺半径：信标距已知敌核心（coreHuntMemory）≤ 该值 = 敌方基地/战区，
 *  不单独 fetch（单骑深入送死——t2 生产实证：信标即 jerkman 核心所在地，
 *  小队 1V+3R+1W 埋伏，信标 Vanguard 被击杀）。由 militaryHunt 攻坚处理，
 *  敌核心被摧毁后我方单位在格上经主循环自动拾取。 */
const BEACON_CONTEST_RADIUS = 10;
/** 信标移动判定窗口（beaconGrab 防追标，2026-08-08）：近 30 tick 内信标
 *  出现过 ≥2 个不同位置 = 在移动/刚停下（敌方核心携带中或停靠）——不单独 fetch；
 *  彻底静止 30+ tick（真掉落/无主）才拾取。10 tick 只挡"正在追"，挡不住
 *  "敌方刚停靠"（t2 实证：信标 68891 后停 [-11,-1]，疑似 jerkman 停靠）。 */
const BEACON_MOVE_WINDOW_TICKS = 30;
/** 威胁自适应（2026-08-07，排行榜威胁画像"留强"）：AGGRESSOR（伤害 top30）
 *  攻坚成型门槛叠加 +2；ELITE_AGGRESSOR（伤害 top10，猛攻蛆头子）叠加 +4。 */
const THREAT_AGGRESSOR_ATTACK_FORCE_BONUS = 2;
const THREAT_ELITE_ATTACK_FORCE_BONUS = 4;
/** 威胁自适应守家预留：高威胁对手至少留 2 个 Vanguard 守家（防偷家/反打）。 */
const THREAT_ADAPTIVE_RESERVE_GUARDS = 2;
/** B6 有界攻坚（竞品 bounded mission distance）：记忆敌 Core 距我方 Core 上限。
 *  40→64（2026-08-07 对齐官方 guide ASSAULT_HOME_CORE_DISTANCE=64，Chebyshev）：
 *  旧 40 把"65 格外的近敌基地"误判为远征送死——t2 生产实证：敌方 jerkman 核心
 *  在 [-38,0]（Chebyshev 49，持信标、主动来犯）被判 bounded_return 全体回家、
 *  军事永不还击。guide 语义：≤64 格由最近完整小队直接远征。 */
const BOUNDED_RAID_DISTANCE = 64;
/** 清剿可见敌方 WORKER 的追击半径（2026-08-08，用户"挂机/落单单位赶紧打掉"）：
 *  可见敌 WORKER 在该半径内且远离敌核心守军时，最近 Vanguard 追击清剿（白赚）。
 *  12 = 适中（不跨图远征，避免补给线风险）。 */
const PREY_WORKER_RADIUS = 12;
/** 清剿目标与敌核心记忆的最小距离（Chebyshev）：敌核心 8 格内 = 有守军风险，
 *  不追（避免冲进敌核心射程送死）。 */
const PREY_CORE_SAFE = 8;
/** 挂机 WORKER 记忆回访窗口（tick，2026-08-08）："确认静止"目击后仍可追的时限——
 *  短窗口防追已经移动/消失的幽灵目标。 */
const PREY_STATIONARY_TTL = 12;
/** 近核入侵观察默认参数（2026-08-08，core-threat-watch-v1）：与
 *  World.CORE_WATCH_RADIUS / CORE_WATCH_TTL 同值；配置可覆盖。 */
const CORE_THREAT_WATCH_RADIUS = 18;
const CORE_THREAT_WATCH_TICKS = 60;
/** W55 单入口掩体搜索默认半径（Chebyshev，对齐 ref AGGRESS_CORE_SHELTER_SEARCH_RADIUS）。 */
const CORE_SHELTER_DEFAULT_RADIUS = 8;
/** 攻坚集结参数（2026-08-08，rally-assault-v1）：敌核外圈集结位距敌核
 *  Chebyshev RALLY_DISTANCE（敌守军 Vanguard 射程 1 / Ranger 射程 3，站 5 格外
 *  安全）；单位进入集结位半径 RALLY_ARRIVE_RADIUS 视为已到；≥RALLY_READY_COUNT
 *  或首到后 RALLY_TIMEOUT_TICKS 强制成建制压上（防永久空等）。 */
const RALLY_DISTANCE = 5;
const RALLY_ARRIVE_RADIUS = 2;
const RALLY_READY_COUNT = 3;
const RALLY_TIMEOUT_TICKS = 40;
/** 攻坚单位距敌核 ≤ RALLY_ATTACK_RADIUS = 已在敌核攻击圈内，直接压上不集结
 *  （已投入战斗，回集结位反而送死）。 */
const RALLY_ATTACK_RADIUS = 4;
/** 斩首配额会计（W10，sortie-quota-v1，2026-08-09，B2 缺陷 1 修复）：
 *  weakCoreOrderedTargets 全军事扑同一弱核 → 按家防余量分档借调 1V+2R
 *  编成 sortie。参数对齐 arena_hero_strategy.py：
 *  - CORE_ASSAULT_MAX_HOME_DISTANCE=28（:145）：sortie 目标距我方 Core 上限；
 *  - lifecycle 72 tick / sighting 96 tick / guard radius 8（与 PREY_CORE_SAFE 同口径）；
 *  - AGGRESS_DEFENDER_VANGUARDS=3 + RANGERS=3（:138-139）家防余量门槛；
 *  - CORE_ASSAULT_MIN_VANGUARDS=1 + MIN_RANGERS=2（:143-144）每 sortie 借调编成。 */
const SORTIE_MAX_HOME_DISTANCE = 28;
const SORTIE_LIFETIME_TICKS = 72;
const SORTIE_SIGHTING_TICKS = 96;
const SORTIE_GUARD_RADIUS = 8;
const SORTIE_HOME_VANGUARD_RESERVE = 3;
const SORTIE_HOME_RANGER_RESERVE = 3;
const SORTIE_VANGUARDS_PER_SORTIE = 1;
const SORTIE_RANGERS_PER_SORTIE = 2;
/** 寡不敌众撤退参数（2026-08-08，outnumbered-retreat-v1，guide 巡逻单位兵力
 *  不足撤退对照）：判定半径 aggressive 10 / defensive 6（guide 同值，Chebyshev）；
 *  守家豁免圈 = REINFORCE_HOME_RING（4，Core 防区不撤——最后防线接战）；敌核
 *  守军豁免半径 = PREY_CORE_SAFE（8，known CORE 守军不算"遭遇战"——攻坚不因
 *  目标守军撤退）。 */
const OUTNUMBERED_RADIUS_AGGRESSIVE = 10;
const OUTNUMBERED_RADIUS_DEFENSIVE = 6;
/** 挂机 WORKER 记忆回访半径（Manhattan）：无敌核清扫目标时 Vanguard 对静止敌
 *  WORKER 的追击上限——有界不跨图远征（白赚但不过度绕路）。 */
const PREY_STATIONARY_RADIUS = 25;
/** Ranger 射程环展开方向（2026-08-08，t1 生产实证：6 Ranger 全堆敌核记忆
 *  3 格环同格，capacity_wait:ranger_move 92 次/30 tick，火力无法展开）：
 *  射程内站定且本格拥挤时，向相邻空位移动保持火力散开（8 方向优先横竖）。 */
const RANGER_SPREAD_DELTAS: readonly (readonly [number, number])[] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];
/** 军事打野沿环扫描时间预算：同一八分点目标 >N tick 未到达强制换向（防障碍点卡死）。 */
const SCAVENGE_HOLD_TICKS = 24;
/** C7 军事单位卡死连续上限（2026-08-10）：位置连续 N tick 不变 = 容量互堵/
 *  路径被堵 → 强制 spread 到相邻空格（复用 nearestFreeAdjacent），打断
 *  capacity_wait 无限循环（不产生 UNIT_MOVE_FAILED → moveFailedStreak 盲区）。
 *  阈值 20（非 3）：vanguard_watch_clear/vanguard_reinforce 等正常待命逻辑
 *  在 checkMilitaryStuckSpread 之后，短 streak 会误覆盖回访清剿；20 tick
 *  让正常待命（core-threat-watch 18 tick 窗口）不触发，只真卡死（≥20）才 spread。 */
const MILITARY_STUCK_TICKS = 20;
/**
 * 军事散开一格（2026-08-10，vanguard_pressure 互堵修复）：从本格 8 邻选
 * "非障碍、己方占用 <2（容量 2）、无可见敌"的最近格——横竖优先（数组序，
 * 确定性）。全部满/被堵 → null（原地等本 tick 腾位，不硬挤 CELL_UNIT_LIMIT）。
 * 只保证"不挤满格"，方向性由调用方 stepToward 到目标继续承担。
 */
function nearestFreeAdjacent(
  from: Position,
  obstacles: ReadonlySet<string>,
  occupancy: ReadonlyMap<string, number>,
  enemies: readonly VisibleEntity[],
): Position | null {
  for (const [dx, dy] of RANGER_SPREAD_DELTAS) {
    const candidate: Position = [from[0] + dx, from[1] + dy];
    if (obstacles.has(cellKey(candidate))) continue;
    if ((occupancy.get(cellKey(candidate)) ?? 0) >= 2) continue;
    if (enemies.some((enemy) => samePosition(enemy.position, candidate))) continue;
    return candidate;
  }
  return null;
}
/** 产兵让位连续上限（spawn-yield-v1）：满载 worker 连续让位 ≥N tick 后
 *  强制卸货——防"核心永远想产兵、worker 永远卸不了"的让位饿死循环
 *  （核心每 tick 产 1 兵后资源下降，正常情况让位 1-2 tick 即恢复卸货）。 */
const SPAWN_YIELD_MAX_TICKS = 3;
/** 锁阵默认参数（worker-blockade-v1，2026-08-08，研究驱动设计）：
 *  锁位 worker 上限 2 / 经济保底 6 / 锁龄上限 10 / 环境锁点最远 24 格
 *  （超出视为远征送死，防锁位单位深入敌阵）。 */
const BLOCKADE_WORKER_CAP = 2;
const BLOCKADE_MIN_WORKERS = 6;
const BLOCKADE_LOCK_MAX_TICKS = 10;
/** 终点封锁锁龄上限（2026-08-08）：核心入口锁手提前部署（敌方可能还有
 *  十几格回程），10 tick 普通锁龄会先满而敌方未到 → 提前放弃。30 tick
 *  覆盖常见回程长度（t2 实证敌方直线段 3-18 tick）+ 缓冲；敌方真绕路/
 *  预测错 30 tick 后锁手回巡逻（自我纠正）。 */
const BLOCKADE_CORE_LOCK_MAX_TICKS = 30;
const BLOCKADE_ENV_MAX_DIST = 24;
/** VANGUARD 预判拦截参数（vanguard-blockade-v1，2026-08-08，手操实证）：
 *  拦截手上限 1（Vanguard 数量有限，t1 7 个，抽 1 个不影响守家/攻坚）；
 *  站桩锁龄 20（到达拦截点后目标未到 → 放弃，防 Vanguard 长期闲置）。 */
const VANGUARD_BLOCKADE_CAP = 1;
const VANGUARD_BLOCKADE_MAX_TICKS = 20;
/** 敌情狩猎清扫半径（Chebyshev）：进入该范围视为"到达基地"，开始扇形清扫。 */
const HUNT_SWEEP_RADIUS = 4;
/** 敌情狩猎清扫时长：单位在基地清扫圈内停留该 tick 数仍未发现敌 Core → 记
 *  清扫并旋转到下一目标（竞品 "整个区域被视野覆盖且未发现 Core 才删除"）。 */
const HUNT_SWEEP_TICKS = 8;
/** W62 环形扇区扫荡参数（2026-08-09，assault-sector-sweep-v1，竞品
 *  `_assault_frontier_target` :6955 对照）：半径在 MIN→MAX 间振荡（近-远-近
 *  循环覆盖）+ 扇区索引在 8 方位间旋转（覆盖全方向）；全员到齐门控推进航点。
 *  默认 MIN 8 / MAX 28（对齐 WIDE_EXPLORE_DEFAULTS.aggressSweepMax）。 */
const ASSAULT_SWEEP_MIN_RADIUS = 8;
const ASSAULT_SWEEP_MAX_RADIUS = 28;
const ASSAULT_SWEEP_WAYPOINT_REACHED_RADIUS = 4;
/** W62 扇区符号组合（8 方位，顺时针：E SE S SW W NW N NE）。 */
const ASSAULT_SWEEP_SECTOR_OFFSETS: readonly (readonly [number, number])[] = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];
/** Worker 局部活性恢复后，短期禁止再次领取历史矿任务，强制进入 patrol/explore。
 *  8 tick 足够离开原死锁小环，又远短于资源记忆 TTL；当前可见矿仍由主流程直接采。 */
const WORKER_LIVENESS_RECOVERY_TICKS = 8;
/** B10 worker 遭遇撤离（竞品 Scout And Observer Response）：撤离触发半径。 */
const SCOUT_EVADE_RADIUS = 3;
/** 到 Core 3 格内后的冷却 tick（竞品 three-Tick cooldown）。 */
const SCOUT_COOLDOWN_TICKS = 3;
/** 到达即进入冷却的 Core 距离（竞品 within three cells）。 */
const SCOUT_HOME_RADIUS = 3;
/** cargoBlockedSelfHeal 默认参数（cargo-rescue-v1，2026-08-09，W6）：
 *  cooldownTicks=30（靠拢触发后 30 tick 内不重触发——迁移中不产兵，频繁靠拢
 *  = 经济停滞）、stallTicks=10（靠拢路径被堵 10 tick 仍未到 → 放弃靠拢）、
 *  minWorkers=2（同时 ≥2 个满载 worker cargo 不变才触发，单个可能是正常排队）、
 *  stallCargoTicks=6（cargo 连续 6 tick 不变视为"被堵"，与 liveness 6 tick
 *  无限循环同口径）、queueHoldRadius=2（满载 worker 距 Core ≤2 入口满 →
 *  原地排队 hold）、entryOccupancyLimit=2（核心格/邻格容量 2 含 Core，≥2 即满）。 */
const CARGO_RESCUE_COOLDOWN_TICKS = 30;
const CARGO_RESCUE_STALL_TICKS = 10;
const CARGO_RESCUE_MIN_WORKERS = 2;
const CARGO_RESCUE_STALL_CARGO_TICKS = 6;
const CARGO_QUEUE_HOLD_RADIUS = 2;
/** 2026-08-10 Core 迁移自愈 3 守卫（waaiging _choose_core_migration 参考）：
 *  - MIN_DISTANCE=6：target 距 Core ≤6 不迁移（近距离靠 near_core_deposit 锁
 *    + 排队 hold 解决，Core 迁移帮不上反打断交仓）；
 *  - LOGISTICS_HOLD_RADIUS=8：8 格内有"未打转"满载 worker → Core 不动
 *    （防靠拢打断正在交仓的近程 worker）；
 *  - FAR_RANGE_THRESHOLD=12 + FAR_STALL=60/FAR_COOLDOWN=8：远距离场景放宽
 *    stall（防 10 tick 超时杀死）+ 缩短 cooldown（允许持续挪动到目标）。
 *    原 10/30 让 Core 每 40 tick 移 1 格，26 格需 1040 tick 永不到达。 */
const CARGO_RESCUE_MIN_DISTANCE = 6;
const CARGO_RESCUE_LOGISTICS_HOLD_RADIUS = 8;
const CARGO_RESCUE_FAR_RANGE_THRESHOLD = 12;
const CARGO_RESCUE_FAR_STALL_TICKS = 60;
const CARGO_RESCUE_FAR_COOLDOWN_TICKS = 8;
/** GAP 5.4（2026-08-10，t1 生产实证 tick 83922）：cargo rescue 触发目标距离上限。
 *  超过该距离的满载 worker 是"归途中的采集者"（cargo 在返航途中天然不变，
 *  不是被堵），Core 追它只会把自己拖进无限迁移循环（t1 实证：核心每 8 tick
 *  迁移 1 格连续 30+ tick，经济冻结在 res=100）。只有距 Core 近的 worker 才
 *  可能是真卸货阻塞（入口满/路径被堵）。20 = 覆盖 FAR_RANGE 场景（原 26 格
 *  目标设计意图）但排除 39+ 平均返航距离的假阳性。 */
const CARGO_RESCUE_MAX_DISTANCE = 20;
const CARGO_QUEUE_ENTRY_LIMIT = 2;
/** near_core_deposit 锁半径（Manhattan，竞品 arena_hero_strategy.py roles.py:158
 *  `dist_core <= 4`）：满载 worker 距 Core ≤ 该值时禁止因邻接敌改 RETREAT——
 *  保持 DEPOSIT/return_home 朝 Core 步进，跳过排队 hold / 垂直绕行，并把可见
 *  敌占格并入 BFS 障碍绕开敌工朝 Core 推进（贴脸但未上 Core dist>0 仍朝 Core 走）。 */
const NEAR_CORE_DEPOSIT_RADIUS = 4;

/** W37 冲突退避时间窗兜底（2026-08-09，挂 W5，默认关）：
 *  连续 ≥CONFLICT_BACKOFF_THRESHOLD 次 MOVE_FAILED 且 detourDirection 垂直绕行
 *  也无路时，原地 WAIT CONFLICT_BACKOFF_TICKS tick——打破"两单位互挡且绕行格
 *  互占"的互等锁死。参考 arena-evolve heuristic.py:519-533（_move_backoff=tick+2）。 */
const CONFLICT_BACKOFF_THRESHOLD = 3;
const CONFLICT_BACKOFF_TICKS = 2;

/** W38 饥饿门控侦察环带（2026-08-09，挂 W8 explore-radius-wide，默认关）：
 *  非饥饿期 patrolRing 锁在 HUNGER_NEAR_RING_CAP（近程 2 环），饥饿
 *  （>HUNGER_GATE_TICKS 无采集）放开到 EXPLORE_RING_COUNT。参考
 *  arena-evolve heuristic.py:510-514 / :1595-1601（hungry > 200）。 */
const HUNGER_GATE_TICKS = 200;
const HUNGER_NEAR_RING_CAP = 2;

/** moveFailedAvoidance 绕行（v0.3 实验）：单位连续 MOVE_FAILED 后不再盲目重试
 *  同格——沿主方向垂直的候选方向探路（先 UP/DOWN 再 LEFT/RIGHT，排除障碍格）；
 *  垂直全堵再退一格反向（远离目标后 BFS 自然换路）。模拟器实证根因：进攻方与
 *  敌守军每 tick 争唯一推进格（容量 2）→ MOVE_CONTESTED 全失败 → 无反馈重试
 *  死循环；垂直绕行打破争格僵局。 */
function detourDirection(
  position: Position,
  target: Position,
  obstacles: ReadonlySet<string>,
): Direction | null {
  const dx = target[0] - position[0];
  const dy = target[1] - position[1];
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const perpendicular: Direction[] = horizontal ? ["UP", "DOWN"] : ["LEFT", "RIGHT"];
  for (const direction of perpendicular) {
    if (!obstacles.has(cellKey(move(position, direction)))) return direction;
  }
  const primary: Direction = horizontal ? (dx > 0 ? "RIGHT" : "LEFT") : (dy > 0 ? "DOWN" : "UP");
  const reverse: Direction =
    primary === "UP" ? "DOWN" : primary === "DOWN" ? "UP" : primary === "LEFT" ? "RIGHT" : "LEFT";
  if (!obstacles.has(cellKey(move(position, reverse)))) return reverse;
  return null;
}

export interface SafetyPlannerInput {
  readonly state: TickState;
  readonly sharedObstacles?: ReadonlySet<string>;
  readonly allyUsernames?: ReadonlySet<string>;
  /** 低频 MacroPolicy（orchestrator 每 K ticks 产出）；提供时覆盖静态 config。 */
  readonly policy?: MacroPolicy;
}

/** Deterministic, side-effect-free with respect to the game. World memory is local to this planner. */
/** worker 密集扫图方位（worker-dense-scan-v1，纯函数可测）：16 方位分两层——
 *  - index<8：偶数槽 = 8 方位同构（卡+对角，(index*3+7)%8 ×2）——≤8 worker 时
 *    覆盖与历史 8 方位完全一致（对角远矿不回归，A/B 实证：旧纯 %16 分布在
 *    对角远矿场景 4.0→2.0 劣化，因初始方位漏对角）；
 *  - index≥8：奇数槽 = 半八分位填充——多 worker 才加密（8→16 方位间距减半），
 *    稀疏资源发现率 +80%（A/B 实证）。 */
export function workerDenseDirection(index: number): number {
  if (index < 8) return ((index * 3 + 7) % 8) * 2;
  return (((index - 8) * 3 + 7) % 8) * 2 + 1;
}

/** 斩首配额 sortie 记录（W10，sortie-quota-v1，2026-08-09）：每个活跃 sortie
 *  对应一个敌核目标（cellKey 索引），记录编成会计 + 生命周期。借调 1V+2R
 *  编成攻坚小队，跨 tick sticky。取消回收 4 种理由（超时/目击过期/家防被
 *  袭击/目标消失）在 pruneSorties 中裁决。参考 arena_hero_strategy.py
 *  _beacon_local_core_sortie_assignments :5816-6068。 */
interface SortieRecord {
  /** sortie 发起 tick（≤lifetime 超时回收，取消理由 ①）。 */
  startedTick: number;
  /** 目标敌核最近目击 tick（>sightingTicks 过期回收，取消理由 ②）。 */
  sightingTick: number;
  /** 借调先锋 id 集（≤SORTIE_VANGUARDS_PER_SORTIE）。 */
  vanguardIds: Set<string>;
  /** 借调游侠 id 集（≤SORTIE_RANGERS_PER_SORTIE）。 */
  rangerIds: Set<string>;
}

/** W57 双相轮换治疗槽（guardHealRotationTwoPhase）：按 UnitType 各自一个槽，
 *  替代 v1 的单相 hold-timer。patient 相 = 伤员占用治疗槽向 Core 回修；
 *  relief 相 = 前伤员脱离危险血量后槽进入冷却（阻止下一个伤员立即冲入仍被
 *  占用的 Core 格造成 capacity 互堵）。 */
interface HealRotationSlot {
  /** 当前相：patient（伤员占用中）/ relief（冷却中，不接受新伤员）。 */
  phase: "patient" | "relief";
  /** 占用/刚释放槽的单位 id（patient 相 = 当前伤员；relief 相 = 刚脱离危险
   *  血量的前伤员，仍在 Core 格补满/让位移动中）。 */
  occupantId: string;
  /** 当前相开始 tick（telemetry/调试）。 */
  phaseStartTick: number;
  /** 当前相截止 tick（patient = patientPhaseTicks 超时；relief = reliefPhaseTicks
   *  冷却到期，到期后槽释放可被新伤员认领）。 */
  phaseEndTick: number;
}

/** P1 战术小队（tactical-squads-v1）：SafetyPlanner 内部编成的本地租户前缀。
 *  squad id 是 planner 局部身份（TaskForce 引用真实租户 id 属后续接线），
 *  "local" 仅用于保持 local-fleet 命名契约 `tenant:role:index`。 */
const LOCAL_SQUAD_TENANT_ID = "local";

export class SafetyPlanner {
  readonly world: World;
  readonly phase: PhaseMachine;
  /** P4g 流水线预取缓存（决策流水线，2026-08-09）：prefetch 同步计算缓存，
   *  decideCached 取——决策输入与串行 decide 相同，结果逐字节一致。 */
  private prefetchedPlanValue: Plan | null = null;
  private configValue: SafetyPlannerConfig;
  /** P1 战术小队（tactical-squads-v1，默认关）：当前 tick 编成 + 上 tick 成员
   *  归属（sticky 输入）。关闭时恒为空（零回归）。 */
  private tacticalSquadsValue: SquadMembership = EMPTY_SQUAD_MEMBERSHIP;
  private tacticalSquadPrevious: ReadonlyMap<string, string> = new Map();
  /** 当前 SafetyPlanner 配置（热加载 2026-08-08：updateConfig 原子替换引用，
   *  World/巡逻记忆不丢；所有决策路径经 this.config 实时读取）。 */
  get config(): SafetyPlannerConfig {
    return this.configValue;
  }
  /** 热加载配置快照（tick 间调用；非法配置由调用方先校验，这里只做引用替换）。 */
  updateConfig(config: SafetyPlannerConfig): void {
    this.configValue = config;
    // P1 战术小队热载关闭：原子清空编成快照与 sticky 上一代，避免 snapshot
    // 暴露旧代 / re-enable 继承关闭前的成员归属。开启时由下一次 decide 重建。
    if (config.tacticalSquads !== true) {
      this.tacticalSquadsValue = EMPTY_SQUAD_MEMBERSHIP;
      this.tacticalSquadPrevious = new Map<string, string>();
    }
  }

  /** 迁移计划注入（migration-system-v1 §3.3，2026-08-09 接线）：tenant-runtime
   *  每 tick 决策前调用；迁移激活期（LEG_MOVE）军事守位统一外环（guardHomeCell）
   *  ——防军事编队贴核心站 4 邻把核心围死（迁移实证：非守卫军事跟核心走、
   *  核心每格被自己人堵 → 引擎容量拒 → 停滞/REPLAN 循环）。null = 无迁移。 */
  setMigrationPlan(plan: MigrationPlanV1 | null): void {
    this.migrationPlan = plan;
  }
  private migrationPlan: MigrationPlanV1 | null = null;
  /** 迁移激活期判定：计划存在且处于 LEG_MOVE（核心移动中，4 邻必须畅通）。 */
  private get migrationMoving(): boolean {
    return this.migrationPlan !== null && this.migrationPlan.state === "LEG_MOVE";
  }
  /**
   * 迁移路径前方禁占格（migration-lane-v1，2026-08-09）：核心当前位置之后
   * 3 格内（Chebyshev ≤3）的路径格——守卫/满载 worker 的守位/等待位必须
   * 避开这些格（它们即将被核心踩过/核心要移入），否则占住容量 2 →
   * CORE_MOVE_START_FAILED → 核心横跳停滞（t1 生产实证：守卫站核心路径
   * 前方对角格 + 满载 worker 挤 4 邻 → 核心 [-562,-111]/[-563,-111] 横跳
   * 25+ tick、89 次 REPLAN）。核心不在路径上（偏离中）→ 返回空集（不
   * 干扰 REPLAN 流程）。
   */
  private migrationPathAhead(core: Position): ReadonlySet<string> {
    const plan = this.migrationPlan;
    const avoid = new Set<string>();
    if (plan === null) return avoid;
    const cells = plan.path.cells;
    let coreIndex = -1;
    for (let index = 0; index < cells.length; index += 1) {
      if (cells[index]![0] === core[0] && cells[index]![1] === core[1]) {
        coreIndex = index;
        break;
      }
    }
    if (coreIndex < 0) return avoid;
    const limit = Math.min(cells.length, coreIndex + 4);
    for (let index = coreIndex + 1; index < limit; index += 1) {
      const cell = cells[index]!;
      if (Math.max(Math.abs(cell[0] - core[0]), Math.abs(cell[1] - core[1])) <= 3) {
        avoid.add(cellKey(cell));
      }
    }
    return avoid;
  }

  /** P1 战术小队（tactical-squads-v1）：只读编成快照（纯函数结果 / telemetry
   *  消费，不改 schema）。默认关闭时恒为空数组（零回归）。 */
  tacticalSquadSnapshot(): ReadonlyArray<{
    readonly id: string;
    readonly role: TacticalSquadRole;
    readonly index: number;
    readonly vanguardIds: readonly string[];
    readonly rangerIds: readonly string[];
  }> {
    return this.tacticalSquadsValue.squads;
  }

  /**
   * Worker 局部活性恢复：只清这个 Worker 的短期任务/导航状态，并把下一次巡逻方向
   * 旋转到另一个扇区。不会清全局资源/障碍/敌情，也不会修改其他单位。
   *
   * 8 方位用 +3、16 方位用 +5（均与方向数互质），连续恢复不会在两个方向之间
   * 来回摆动；这是 WorkerLivenessTracker 的执行端，检测逻辑不塞回 SafetyPlanner。
   */
  recoverWorker(
    unitId: string,
    currentTick?: number,
  ): { readonly previousDirection: number; readonly nextDirection: number; readonly clearedMoveFailures: number; readonly cooldownUntilTick: number | null } {
    const memory = this.world.unitMemory(unitId);
    const directionCount = this.config.workerDenseScan === true ? 16 : EXPLORE_DIRECTION_COUNT;
    const jump = directionCount === 16 ? 5 : 3;
    const previousDirection = ((memory.patrolDirection % directionCount) + directionCount) % directionCount;
    const nextDirection = (previousDirection + jump) % directionCount;
    memory.workerMode = "patrol";
    memory.harvestTarget = null;
    memory.patrolDirection = nextDirection;
    memory.patrolRing = 0;
    memory.patrolStarted = false;
    memory.patrolReturning = false;
    this.harvestMemStuck.delete(unitId);
    this.moveFailedStreak.delete(unitId);
    this.conflictBackoffUntil.delete(unitId);
    this.spawnYieldStreak.delete(unitId);
    this.blockadeAssignment.delete(unitId);
    this.coreLockHands.delete(unitId);
    this.blockadeLockedSince.delete(unitId);
    this.scoutEvadeState.delete(unitId);
    this.lastWorkerPos.delete(unitId);
    this.workerPositionTrail.delete(unitId);
    const cooldownUntilTick = currentTick === undefined ? null : currentTick + WORKER_LIVENESS_RECOVERY_TICKS;
    if (cooldownUntilTick !== null) this.workerLivenessRecoveryUntil.set(unitId, cooldownUntilTick);
    const clearedMoveFailures = this.world.clearUnitMoveFailures(unitId);
    return { previousDirection, nextDirection, clearedMoveFailures, cooldownUntilTick };
  }
  /** 本 decide 生效的 aggression（policy 优先，其次 config.aggression）。 */
  private effectiveAggression: AggressionLevel = "defensive";
  /** 本 decide 生效的 workerTarget（policy 优先，其次 config.workerTarget）。 */
  private effectiveWorkerTarget = 8;
  /** 本 decide 生效的 policy（focusRegion/attackPriority 消费）。 */
  private effectivePolicy: MacroPolicy | null = null;
  /** 爆兵状态（2026-08-06）：accumulateThreshold 达标后置 true 并保持——
   *  持续爆兵直到资源不足以产兵才回积累期（防止"产 1 兵掉回阈值下"振荡）。 */
  private surgeActive = false;
  /** 军事打野环停留起始 tick（2026-08-07）：单位进入某 patrolRing 的时间点，

   *  用于 militaryRingHoldTicks 时间预算强制升环（破"精确到达才升环"卡死）。 */
  private readonly unitRingSince = new Map<string, number>();
  /** Core 迁移方向（coreEvade）：START_MOVE 发起时记录；次 tick 仍 MOVING
   *  同向 = 已提交（本地等效 move_progress≥2，竞品 CANCEL 语义用）。 */
  private coreMoveDirection: Direction | null = null;
  /** B9 迁移取消冷却（coreMigrationCancel）：取消后 N tick 内不重触发
   *  START_MOVE——防"退路危险 → 取消 → 立即重触发 → 再取消"的每 tick
   *  振荡（实验实证：core-evade-danger 场景 START/CANCEL 各 200 次）。 */
  private coreMigrationCancelUntilTick = 0;
  /** PRE_EVADE 持续截止 tick（竞品 preemptive_evade_until_tick = tick + 2）：
   *  触发迁移后即使敌人消失，2 tick 内仍保持迁移意图（防止"敌人闪失 →
   *  立刻取消"抖动）。 */
  private preemptiveEvadeUntilTick = 0;
  /** MOVE_FAILED 连续失败计数（moveFailedAvoidance）：单位连续 N tick 移动被
   *  结算拒绝时改走垂直绕行格，避免无反馈重试同格死循环。 */
  private moveFailedStreak = new Map<string, number>();
  /** W37 冲突退避冷却截止 tick（conflictBackoff，unitId → tick）：连续 ≥3 次
   *  MOVE_FAILED 且 detourDirection 无路时触发，cooldown 内原地 WAIT——打破
   *  两单位互挡且绕行格互占的互等锁死（空间绕行失败 → 时间等待）。 */
  private readonly conflictBackoffUntil = new Map<string, number>();
  /** W38 饥饿门控上次采集 tick（hungerGate，unitId → lastHarvestTick）：
   *  decide() 事件循环消费 HARVEST_SUCCEEDED 更新；patrolRing 截断时读取——
   *  非饥饿期（tick - lastHarvest ≤ gateTicks）锁近环，饥饿放开远环。 */
  private readonly lastHarvestTick = new Map<string, number>();
  /** W61（beacon-commitment-v1）：上一轮 beacon fetch 设计者 id（跨 tick 持久，
   *  防每 tick 因距离微差换设计者 → 中途放弃信标）。beacon 关闭/信标
   *  CARRIED/移动/战区/远征时不重置（任一闸门返回 null 时保留，下次 GROUND
   *  静止近距仍可复用）；设计者不在候选池时自然失效（新轮选新设计者）。 */
  private beaconFetchDesigneeId: string | null = null;
  /** 产兵让位连续计数（spawn-yield-v1）：满载 worker 连续让位 tick 数——超过
   *  spawnYieldMaxTicks 强制卸货，防"核心永远想产兵、worker 永远卸不了"。 */
  private spawnYieldStreak = new Map<string, number>();
  /** 锁阵本 tick 配对（worker-blockade-v1）：unitId → lockPoint（敌方下一步
   *  要进的格，站桩即挡）。decide 入口由 enemyReturnPath + 环境锁点计算一次，
   *  decideWorker 消费（多 worker 共享同一分配，防扎堆/重复锁同一目标）。 */
  private blockadeAssignment = new Map<string, Position>();
  /** 终点封锁锁手标记（unitId，2026-08-08）：配到"敌核心入口邻格"的锁手——
   *  锁龄用放宽上限（BLOCKADE_CORE_LOCK_MAX_TICKS=30），防锁手提前到达
   *  而 10 tick 锁龄先满、敌方回程未到就提前放弃。 */
  private coreLockHands = new Set<string>();
  /** 锁阵站桩起始 tick（unitId → tick）：站桩超过 blockadeLockMaxTicks 仍未
   *  等到目标 → 放弃回巡逻（预测错误/敌方已绕路，防锁位单位长期闲置）。 */
  private blockadeLockedSince = new Map<string, number>();
  /** VANGUARD 预判拦截配对（vanguard-blockade-v1，2026-08-08）：unitId →
   *  拦截点。decide 入口由 enemyReturnPath 计算（只锁敌方 WORKER），
   *  decideVanguard 消费（SWEEP 之后、prey 之前——邻接敌先打）。 */
  private vanguardBlockadeAssignment = new Map<string, Position>();
  /** 拦截站桩起始 tick（unitId → tick）：超过 vanguardBlockadeMaxTicks
   *  目标未到 → 放弃（预测错误/目标转向）。 */
  private vanguardBlockadeLockedSince = new Map<string, number>();
  /** 记忆矿卡死防护（2026-08-08，t3 生产实证）：worker 连续 go_harvest_mem 未推进
   *  的 tick 数（capacity_wait 是 planner 内部拒绝，不产生 MOVE_FAILED 事件，
   *  需独立计数）。 */
  private harvestMemStuck = new Map<string, number>();
  /** 上 tick worker 位置（记忆矿卡死检测：位置未变 = 未推进）。 */
  private lastWorkerPos = new Map<string, Position>();
  /** Pattern 1（soft_obstacles_from_trail，竞品 waaiging arena-hero-tactic
   *  pathing.py:383-406）：worker 近期位置轨迹（最后 6 tick）。检测到振荡
   *  （≤3 唯一位置 over trail）时把轨迹格变软障碍，逼寻路离开循环区域——
   *  防恢复后 re-oscillation。当前格永不被封；全封时回退不困死 worker。 */
  private workerPositionTrail = new Map<string, Position[]>();
  /** C7 修复（2026-08-10）：军事单位卡死连续 tick 计数（capacity_wait 不产生
   *  UNIT_MOVE_FAILED → moveFailedStreak 盲区 → 军事单位无限 WAIT）。
   *  用 lastWorkerPos（实际存所有单位位置）检测位置未变，连续 ≥3 tick
   *  → 强制 spread 到相邻空格（复用 nearestFreeAdjacent）。 */
  private militaryStuckStreak = new Map<string, number>();
  private rangerConsecutiveMisses = new Map<string, number>();
  /** Worker 活性恢复冷却：unitId → 截止 tick。冷却内不主动领取 stale memory mine，
   *  让 reset+rotate 真正获得一段探索窗口，防下一 Tick 又被同一历史任务吸回去。 */
  private workerLivenessRecoveryUntil = new Map<string, number>();
  /** 本 tick 记忆矿采集槽占用（cellKey -> worker 数；自然节点吞吐=1，与实体格容量解耦）。 */
  private allocatedMines = new Map<string, number>();
  /** 本 tick 威胁评估（threatBreakout 用）：decide 入口计算一次供 worker 消费。 */
  private currentThreat: ThreatAssessment | null = null;
  /** 受击记忆到期 tick（2026-08-08 对齐竞品 recent_core_attack）：Core 受击后
   *   RECENT_ATTACK_MEMORY_TICKS 内保持 ENGAGED，即使敌人消失也不立刻放松。 */
  private recentAttackUntilTick = 0;
  /** B5 突击组被拦截后的返回截止 tick（unitId → tick；8-tick 防抖动记忆）。 */
  private detachedReturnUntil = new Map<string, number>();
  /** 远端军事回援状态（unitId → 回援截止 tick；remoteReinforce 候选）。 */
  private reinforceUntil = new Map<string, number>();
  /** 敌情狩猎清扫状态（2026-08-07）：huntArriveAt = 单位进入某基地清扫圈的起始
   *  tick（unitId → {key, tick}）；huntSweptAt = 基地已清扫 tick（key → tick，
   *  目标 lastSeenTick > sweptAt 视为"清扫后重新发现"，恢复狩猎）。 */
  private readonly huntArriveAt = new Map<string, { key: string; tick: number }>();
  private readonly huntSweptAt = new Map<string, number>();
  /** 攻坚集结状态（2026-08-08，rally-assault-v1）：targetKey -> { ready, firstArriveTick }。
   *  集结位在敌核外圈，组齐（ready）或超时后成建制压上；目标被重新目击/更换时重置。 */
  private readonly rallyTargets = new Map<string, { ready: boolean; firstArriveTick: number }>();
  /** 攻坚集结目标复位（P2 2026-08-10）：上一次主核心目标 cellKey。目标变化
   *  （新 coreHunt 目标/迁移/遗忘）时复位旧 key 的 ready——rallyTargets 只
   *  set 不 delete，旧目标 key 永久残留（长局无界增长），且 ready 置真后
   *  永不复位（换目标后旧 ready 残留，新集结直接压上不再重新集结）。 */
  private lastRallyHuntKey: string | null = null;
  /** W62 环形扇区扫荡状态（2026-08-09，assault-sector-sweep-v1，竞品
   *  `_assault_frontier_target` :6955 对照）：全队共享前沿航点几何——
   *  assaultSweepStep 是周期步进计数器（半径在 MIN→MAX 间振荡 + 扇区旋转），
   *  assaultSweepLastAdvanceTick 防同 tick 多次推进。全员到齐门控推进航点。
   *  未启用时永 0（零回归）。 */
  private assaultSweepStep = 0;
  private assaultSweepLastAdvanceTick = -1;
  /** 斩首配额会计（W10，sortie-quota-v1，2026-08-09）：sortieKey（目标 cellKey）
   *  → SortieRecord。借调 1V+2R 编成攻坚小队，按家防余量分档借调，不全部扑同一
   *  弱核。跨 tick sticky（Map 持久化）+ 超时/过期/家防回援/目标消失 4 种取消回收。
   *  只在 config.sortieQuota === true 时消费；未启用时 Map 永空（零回归）。 */
  private readonly coreSorties = new Map<string, SortieRecord>();
  /** B10 worker 遭遇撤离状态（unitId → 返回截止/冷却截止 tick）。 */
  private scoutEvadeState = new Map<string, { returnUntil: number; cooldownUntil: number }>();
  /** B8 守卫轮换 one-at-a-time：回修流程中的守卫（unitId → 名额占用截止 tick）。 */
  private healRotationActive = new Map<string, number>();
  /** W57 双相轮换治疗槽（guardHealRotationTwoPhase）：按 UnitType 各自一个槽，
   *  patient 相 = 伤员占用治疗槽向 Core 回修；relief 相 = 前伤员脱离危险血量后
   *  槽进入冷却（防下一个伤员立即冲入仍被占用的 Core 格）。未启用时 Map 永空。 */
  private readonly healRotationSlots = new Map<UnitType, HealRotationSlot>();
  /** cargo-rescue-v1（W6，2026-08-09）：满载 worker 的 cargo 快照（unitId →
   *  {cargo, tick}），用于检测"cargo 长时间不变 = 被堵"。每 tick decide 入口
   *  刷新——比较当前 cargo 与上 tick 快照，不变则推进 stuckSince，变化则重置。 */
  private cargoStuckSince = new Map<string, number>();
  /** cargo-rescue-v1：上 tick 的满载 worker cargo 快照（unitId → cargo 值），
   *  供本 tick 比较 cargo 是否变化。每 tick decide 入口刷新。 */
  private cargoStuckCargoSnapshot = new Map<string, number>();
  /** cargo-rescue-v1：cargoBlockedSelfHeal 冷却截止 tick——触发靠拢后该窗口内
   *  不再重触发（避免每 tick 都迁移，迁移中不产兵 = 经济停滞）。 */
  private cargoSelfHealUntilTick = 0;
  /** cargo-rescue-v1：靠拢开始 tick——用于检测"靠拢路径被堵 N tick 仍未到
   *  最近满载 worker 邻格 → 放弃靠拢"（超时撤退）。 */
  private cargoSelfHealStartedTick = 0;
  /** cargo-rescue-v1：靠拢目标 worker id（靠拢进行中保持同一目标，防每 tick
   *  换目标导致 Core 原地震荡）。靠拢完成/超时后清空。 */
  private cargoSelfHealTargetId: string | null = null;
  /** 2026-08-10 守卫 2 远距离参数：当前靠拢的 stall 超时阈值（远距离场景
   *  用 60 而非默认 10，防 Core 每 40 tick 移 1 格永不到达）。null = 用
   *  config 默认 stallTicks。靠拢完成/超时后清空。 */
  private cargoSelfHealStallTicks: number | null = null;
  /** C2 RECOVERY：上次见到的我方 Core id（全新 UUID = 重生/替换 → 清战场记忆）。 */
  private lastCoreId: string | null = null;
  /** C2 RECOVERY 触发次数（telemetry/测试可读）。 */
  coreRecoveryCount = 0;
  /** C2 RECOVERY 事件日志（telemetry/测试可读；正常对局为空）。 */
  readonly recoveryLog: string[] = [];
  /** W10 sortie 取消回收计数（telemetry/测试可读）：pruneSorties 每删除一条
   *  sortie 记录 +1（含 4 种取消理由：超时/目击过期/家防被袭击/目标消失 +
   *  借调单位全灭）。用于验证生命周期回收确实触发（新 sortie 会立即重建，
   *  intent 计数无法区分"旧记录超时回收 + 新记录重建"）。 */
  sortiePruneCount = 0;

  /** 官方排行榜威胁画像（username → tier，2026-08-07）：由 tenant-runtime 从
   *  data/leaderboard/ 快照加载注入；缺省空 Map = 无威胁情报（零回归）。
   *  可变 Map（seedThreatProfiles 装配用），消费端只读。 */
  private readonly threatProfiles = new Map<string, ThreatProfile>();
  /** 联盟 no-fire 花名册（2026-08-08，alliance-no-fire-v1）：可变引用，supervisor
   *  聚合帧 → roster 文件 → 本进程热刷新（替换引用不丢 World/记忆）。decide 每
   *  tick 读 current；knownAllianceEntityId => never deliberate target（spec §5.5）。
   *  null = 未启用（零回归）。 */
  private rosterRef: AllianceRosterRef | null = null;
  /** 矿刷新预测（2026-08-09，chunk-resurvey-v1，W7）：cell → RefillPrediction
   *  （完整对象，含 predictedNextTick/windows/avgGapTicks）。由 tenant-runtime 经
   *  loadRefillPredictions 加载后通过 setRefillPredictions 注入（与 threatProfiles
   *  同模式：定时重读 + 替换引用）。null = 未注入 → chunkResurvey 不执行（零回归）。
   *  注意：生产数据管道（deterministic-planner）侧走的是扁平 Map<string,number>
   *  （predictedNextTick only），W7 消费需要完整 RefillPrediction（planChunkResurvey
   *  契约）——tenant-runtime 注入须直接传 loadRefillPredictions 的原 Map，不要走
   *  loadPredictedTicks 扁平化。 */
  private refillPredictionsValue: ReadonlyMap<string, RefillPrediction> | null = null;
  /** 本 decide 被 no-fire 过滤掉的可见"敌人"数（telemetry/测试可读）：>0 说明
   *  联盟单位互相可见且未被误判为打击目标。 */
  alliedFilteredCount = 0;

  constructor(
    config: SafetyPlannerConfig = DEFAULT_SAFETY_CONFIG,
    world = new World(),
    threatProfiles: ReadonlyMap<string, ThreatProfile> = new Map(),
    rosterRef: AllianceRosterRef | null = null,
  ) {
    this.configValue = config;
    this.world = world;
    this.phase = new PhaseMachine(config.phase);
    this.rosterRef = rosterRef;
    for (const [username, profile] of threatProfiles) {
      this.threatProfiles.set(username, profile);
    }
  }

  /** 当前主要攻坚目标（排行榜威胁画像用）：coreHuntTargets 首个 CORE 目击
   *  目标（排序 = CORE 优先 → 新鲜度）。无目标返回 null。 */
  private currentHuntTarget(): CoreHuntTarget | null {
    return this.world.coreHuntTargets().find((target) => target.source === "CORE") ?? null;
  }

  /** 攻坚目标所有者的威胁等级（威胁自适应）：owner 未知/画像缺失 → null
   *  （不触发自适应，走基础配置）。 */
  private threatTierOf(target: CoreHuntTarget | null): ThreatTier | null {
    const owner = target?.owner;
    if (typeof owner !== "string" || owner.length === 0) return null;
    const profile = this.threatProfiles.get(owner);
    if (profile === undefined) return null;
    return profile.tier === "STANDARD" ? null : profile.tier;
  }

  /** 目标敌 Core 实测守军估计（assault-overmatch-v1）：World.enemyCoreForces
   *  中与当前攻坚目标同格记录的战斗单位数（Vanguard+Ranger 按 ID 去重）。
   *  变体关闭/无目标/无记录 = 0（不抬高门槛）。 */
  private enemyEstimateForTarget(): number {
    if (this.config.assaultOvermatch !== true) return 0;
    const target = this.currentHuntTarget();
    if (target === null) return 0;
    const force = this.world.enemyCoreForces().find(
      (f) => f.position[0] === target.position[0] && f.position[1] === target.position[1],
    );
    if (force === undefined) return 0;
    return force.vanguards.size + force.rangers.size;
  }

  /** 威胁自适应生效时的前压成型门槛：基础 attackForce + 高威胁加成；再叠加
   *  overmatch 严格占优（门槛 = max(前述, 守军估计+1)）。防御变体关闭/无
   *  画像/无守军记录 = 返回基础值，零回归。 */
  private adaptiveAttackForce(): number {
    const base = this.config.attackForce ?? 0;
    if (base <= 0) return base;
    let force = base;
    if (this.config.threatAdaptiveDefense === true) {
      const tier = this.threatTierOf(this.currentHuntTarget());
      if (tier === "ELITE_AGGRESSOR") force += THREAT_ELITE_ATTACK_FORCE_BONUS;
      else if (tier === "AGGRESSOR") force += THREAT_AGGRESSOR_ATTACK_FORCE_BONUS;
    }
    if (this.config.assaultOvermatch === true) {
      const estimate = this.enemyEstimateForTarget();
      force = Math.max(force, estimate + 1);
    }
    return force;
  }

  /** 威胁自适应生效时的守家 Vanguard 预留数：高威胁对手至少留 2 个（叠加
   *  strikeGroupReserve=1 之上）；关闭/非高威胁 = 基础预留（0 或 1）。 */
  private adaptiveReserveGuards(state: TickState): number {
    // 快攻防御（raid-defense-v1，2026-08-07）：邻近敌核心恒留强守家——即使攻坚
    // 目标不是排行榜高威胁玩家，对方也可能派小股来偷家（用户裁决"别人可以只
    // 派一些人来打"）。优先级高于威胁自适应（不依赖攻坚目标身份）。
    if (this.config.raidDefense === true && this.nearbyEnemyCore(state)) {
      return Math.max(THREAT_ADAPTIVE_RESERVE_GUARDS, this.config.strikeGroupReserve === true ? 1 : 0);
    }
    if (this.config.threatAdaptiveDefense !== true) {
      return this.config.strikeGroupReserve === true ? 1 : 0;
    }
    const tier = this.threatTierOf(this.currentHuntTarget());
    if (tier === "ELITE_AGGRESSOR" || tier === "AGGRESSOR") return THREAT_ADAPTIVE_RESERVE_GUARDS;
    return this.config.strikeGroupReserve === true ? 1 : 0;
  }

  /** 守卫选择（B7 + home-guard-squad-v1，2026-08-09）：返回单位是否为本次 tick
   *  的守家编成成员。homeGuardSquad 开启时按"距 Core 最近"选 N 个 Vanguard 守家
   *  （Ranger 由 decideRanger 同口径选择）——留守最近的兵、远征用最远的兵；
   *  homeGuardSquad 关闭 = 旧 UUID 排序语义（strikeGroupReserve 兼容，零回归）。
   *  总兵力不足（≤ 守卫数）时全部守家——家不空防优先于进攻编成。 */
  private isHomeGuardUnit(state: TickState, unit: UnitSnapshot, guardCount: number): boolean {
    if (guardCount <= 0) return false;
    if (state.core === null) return false;
    if (this.config.tacticalSquads === true) {
      // 稳定 squad 身份：HOME_DEFENSE 编队成员即守家（sticky，不再每 tick
      // 按距离重排漂移；家防不被借空）。
      return this.squadOf(unit.id)?.role === "HOME_DEFENSE";
    }
    const corePosition = state.core.position;
    if (this.config.homeGuardSquad === true) {
      const sorted = [...state.vanguards]
        .map((v) => ({ id: v.id, dist: chebyshev(v.position, corePosition) }))
        .sort((a, b) => a.dist - b.dist || a.id.localeCompare(b.id));
      return sorted.slice(0, guardCount).some((v) => v.id === unit.id);
    }
    const sortedVanguards = [...state.vanguards].map((v) => v.id).sort();
    return (
      sortedVanguards.length > guardCount &&
      sortedVanguards.slice(-guardCount).includes(unit.id)
    );
  }

  /** home-guard-squad-v1 Ranger 守卫判定（2026-08-09）：距 Core 最近的
   *  homeGuardRangers 个 Ranger 守家（留守最近的游侠、远征用最远的）。
   *  与 isHomeGuardUnit 同口径（距离升序 + id 决胜稳定排序）。 */
  private isHomeGuardRanger(state: TickState, unit: UnitSnapshot): boolean {
    if (this.config.tacticalSquads === true) {
      const squad = this.squadOf(unit.id);
      return squad !== undefined && squad.role === "HOME_DEFENSE";
    }
    if (this.config.homeGuardSquad !== true) return false;
    const count = this.config.homeGuardRangers ?? 4;
    if (count <= 0) return false;
    if (state.core === null) return false;
    const corePosition = state.core.position;
    const sorted = [...state.rangers]
      .map((r) => ({ id: r.id, dist: chebyshev(r.position, corePosition) }))
      .sort((a, b) => a.dist - b.dist || a.id.localeCompare(b.id));
    return sorted.slice(0, count).some((r) => r.id === unit.id);
  }

  /** P1 战术小队（tactical-squads-v1）：查询单位所属 squad（关闭时恒 undefined）。 */
  private squadOf(unitId: string): TacticalSquad | undefined {
    if (this.config.tacticalSquads !== true) return undefined;
    const squadId = this.tacticalSquadsValue.squadByUnit.get(unitId);
    if (squadId === undefined) return undefined;
    return this.tacticalSquadsValue.squads.find((squad) => squad.id === squadId);
  }

  /** P1 战术小队（tactical-squads-v1）：按单位所属 squad + 成员序号选 rally 集结
   *  位——同 squad 的 2V+1R 各占不同格（不共用容量 2 的单格），不同 squad 也不
   *  共用单格（8 squad × 3 成员 = 24 格互异）；关闭或单位无编成时回落历史单一
   *  集结位（slot=0 语义，零回归）。 */
  private rallyPointForUnit(
    unit: UnitSnapshot,
    target: Position,
    home: Position,
    obstacles: ReadonlySet<string>,
    resourceCells: ReadonlySet<string>,
  ): Position {
    if (this.config.tacticalSquads !== true) {
      return this.rallyPoint(target, home, obstacles, resourceCells);
    }
    const squad = this.squadOf(unit.id);
    if (squad === undefined) {
      return this.rallyPoint(target, home, obstacles, resourceCells);
    }
    const members = [...squad.vanguardIds, ...squad.rangerIds];
    const memberIndex = members.indexOf(unit.id);
    const slot = rallyMemberSlot(squad.index, memberIndex === -1 ? 0 : memberIndex);
    return rallyPointAtMemberSlot(target, home, obstacles, resourceCells, slot);
  }

  /** 启动播种（持久敌情测绘，2026-08-07）：从历史 calibration cases 提取的最后
   *  已知敌 Core 位置注入 World——重启后军事仍记得敌方基地（解决"重启→记忆
   *  清零→军队空转"）。返回实际播种数。 */
  seedCoreHuntTargets(targets: readonly CoreHuntTarget[]): number {
    return this.world.seedCoreHuntTargets(targets);
  }

  /** 注入官方排行榜威胁画像（2026-08-07，deterministic-planner 装配用）：
   *  追加式设置——构造后由装配点传入（旧画像保留，供启动装配）。 */
  seedThreatProfiles(profiles: ReadonlyMap<string, ThreatProfile>): void {
    for (const [username, profile] of profiles) {
      this.threatProfiles.set(username, profile);
    }
  }

  /** 热刷新官方排行榜威胁画像（2026-08-08）：**替换式**——清空旧画像再填新，
   *  掉榜用户（如伤害排名滑出）立即移除，杜绝陈旧威胁情报残留。供
   *  tenant-runtime 定时重读 leaderboard 快照后调用；空 Map = 清空（零回归）。 */
  replaceThreatProfiles(profiles: ReadonlyMap<string, ThreatProfile>): void {
    this.threatProfiles.clear();
    for (const [username, profile] of profiles) {
      this.threatProfiles.set(username, profile);
    }
  }

  /** 注入矿刷新预测（2026-08-09，chunk-resurvey-v1，W7）：替换式引用更新——
   *  供 tenant-runtime 定时重读 survey-db 后调用（与 replaceThreatProfiles 同模式）。
   *  null/空 Map = 清空 → chunkResurvey 不执行（零回归）。注意：需注入完整
   *  RefillPrediction Map（loadRefillPredictions 原始返回值），**不要**走
   *  loadPredictedTicks 扁平化（planChunkResurvey 契约要求完整对象）。 */
  setRefillPredictions(predictions: ReadonlyMap<string, RefillPrediction> | null): void {
    this.refillPredictionsValue = predictions;
  }

  /** 敌情狩猎扫掠点：远距离（>清扫圈）直接朝基地中心；近距离按单位序号绕基地
   *  圆周展开（DENSE_DELTAS × 2，16 方位）——小队扇形覆盖清扫，防所有单位挤
   *  同格/同向（竞品彻查时"优先选择新增覆盖最多、相互视野重叠最少的目标"）。 */
  /** 寡不敌众判定（outnumbered-retreat-v1，2026-08-08，guide 巡逻单位兵力不足
   *  撤退对照）：非守家（>home ring）单位遇可见敌战斗单位（Vanguard/Ranger，
   *  排除 Worker）且附近我方军事 < 敌（aggressive 严格劣势 / defensive ≤）→
   *  true。敌核守军（known CORE 8 格内）不计入——攻坚目标守军不算遭遇战，
   *  否则围攻守军核心时永远"寡不敌众"撤退。确定性（同输入同输出）。 */
  private outnumbered(state: TickState, unit: UnitSnapshot, enemies: readonly VisibleEntity[]): boolean {
    if (state.core === null) return false;
    if (manhattan(unit.position, state.core.position) <= REINFORCE_HOME_RING) return false;
    const radius = this.config.outnumberedRetreatRadius
      ?? (this.effectiveAggression === "aggressive" ? OUTNUMBERED_RADIUS_AGGRESSIVE : OUTNUMBERED_RADIUS_DEFENSIVE);
    const nearEnemyCore = (enemy: VisibleEntity): boolean =>
      this.world.coreHuntTargets().some(
        (t) => t.source === "CORE" && chebyshev(t.position, enemy.position) <= PREY_CORE_SAFE,
      );
    const combatEnemies = enemies.filter(
      (e) =>
        e.kind === "UNIT" &&
        e.unitType !== "WORKER" &&
        chebyshev(unit.position, e.position) <= radius &&
        !nearEnemyCore(e),
    );
    if (combatEnemies.length === 0) return false;
    const localAllies = [...state.vanguards, ...state.rangers].filter(
      (u) => u.id !== unit.id && chebyshev(unit.position, u.position) <= radius,
    ).length;
    return this.effectiveAggression === "aggressive"
      ? localAllies < combatEnemies.length
      : localAllies <= combatEnemies.length;
  }

  /** 弱核优先排序（weak-core-first-v1，2026-08-08，guide "已知核心优先选无护卫"
   *  对照）：多敌核时按守军估计升序（无兵力记忆 = 无护卫弱目标优先）→ 新鲜度 →
   *  距我方 Core 近 → 坐标。供狩猎/前压目标选择；默认关闭返回历史顺序（CORE
   *  优先→最新→坐标，零回归）。守军记忆窗口 weakCoreFirstForceTicks（默认 20）。 */
  private weakCoreOrderedTargets(state: TickState): readonly CoreHuntTarget[] {
    const candidates = this.world.coreHuntTargets().filter((t) => t.source === "CORE");
    if (candidates.length <= 1 || this.config.weakCoreFirst !== true) return candidates;
    const forceTicks = this.config.weakCoreFirstForceTicks ?? 20;
    const forces = this.world.enemyCoreForces(forceTicks);
    const guardOf = (pos: Position): number => {
      const f = forces.find((x) => cellKey(x.position) === cellKey(pos));
      return f === undefined ? 0 : f.vanguards.size + f.rangers.size;
    };
    const home = state.core?.position;
    return [...candidates].sort((a, b) => {
      const ga = guardOf(a.position);
      const gb = guardOf(b.position);
      if (ga !== gb) return ga - gb;
      if (b.lastSeenTick !== a.lastSeenTick) return b.lastSeenTick - a.lastSeenTick;
      if (home !== undefined) {
        const da = manhattan(a.position, home);
        const db = manhattan(b.position, home);
        if (da !== db) return da - db;
      }
      return a.position[0] - b.position[0] || a.position[1] - b.position[1];
    });
  }

  /** 家防余量（W10，sortie-quota-v1）：总军事减去已借调入 sortie 的单位 = 留守
   *  家防可调度的余量。借调门槛要求余量 vanguards ≥3 + rangers ≥3 才能再借调
   *  1V+2R（arena_hero_strategy.py :138-139 AGGRESS_DEFENDER_*）；家防被袭击时
   *  余量跌破门槛 → 取消借调回援（取消理由 ③）。纯查询，不修改状态。 */
  private homeDefenseReserves(state: TickState): { vanguards: number; rangers: number } {
    let borrowedVanguards = 0;
    let borrowedRangers = 0;
    for (const rec of this.coreSorties.values()) {
      borrowedVanguards += rec.vanguardIds.size;
      borrowedRangers += rec.rangerIds.size;
    }
    return {
      vanguards: Math.max(0, state.vanguards.length - borrowedVanguards),
      rangers: Math.max(0, state.rangers.length - borrowedRangers),
    };
  }

  /** sortie 取消回收（W10，sortie-quota-v1）：decide 入口每 tick 调用一次，
   *  裁决 4 种取消理由——
   *  ① 生命周期超时（startedTick + lifetime ≤ tick）；
   *  ② 目击过期（目标敌核不在当前 coreHuntTargets 或 lastSeenTick 已超 sightingTicks）；
   *  ③ 家防被袭击（threat 非 NORMAL/CALM 且家防余量跌破门槛）→ 取消借调回援；
   *  ④ 目标敌核被摧毁/迁移消失（不在 coreHuntTargets，且非过期——已被 forgetCoreHuntAt
   *    在 decide 入口清除，此处兜底清理残留 sortie 记录）。
   *  TODO：W 源码 9 种取消理由中的另外 5 种（rally 失败/护卫脱节/敌核移动出新位置/
   *  我方 Core 被迫迁移/补给线被截）留 W15 beacon-expedition 实现。 */
  private pruneSorties(state: TickState): void {
    if (this.coreSorties.size === 0) return;
    const lifetimeTicks = this.config.sortieLifetimeTicks ?? SORTIE_LIFETIME_TICKS;
    const sightingTicks = this.config.sortieSightingTicks ?? SORTIE_SIGHTING_TICKS;
    const liveTargets = new Map<string, CoreHuntTarget>();
    for (const target of this.world.coreHuntTargets()) {
      if (target.source === "CORE") liveTargets.set(cellKey(target.position), target);
    }
    const homeUnderAttack =
      this.currentThreat !== null && this.currentThreat.level !== "NORMAL";
    const reserves = this.homeDefenseReserves(state);
    const reservesShortfall =
      homeUnderAttack &&
      (reserves.vanguards < SORTIE_HOME_VANGUARD_RESERVE || reserves.rangers < SORTIE_HOME_RANGER_RESERVE);
    for (const [key, rec] of this.coreSorties) {
      // ① 生命周期超时
      if (state.tick - rec.startedTick >= lifetimeTicks) {
        this.coreSorties.delete(key);
        this.sortiePruneCount += 1;
        continue;
      }
      const target = liveTargets.get(key);
      // ④ 目标消失（已被 forgetCoreHuntAt 清除）或 ② 目击过期
      if (
        target === undefined ||
        state.tick - target.lastSeenTick > sightingTicks
      ) {
        this.coreSorties.delete(key);
        this.sortiePruneCount += 1;
        continue;
      }
      // ③ 家防被袭击 + 余量跌破门槛 → 取消借调回援
      if (reservesShortfall) {
        this.coreSorties.delete(key);
        this.sortiePruneCount += 1;
        continue;
      }
      // 清理已死亡/不存在单位的 id（防 stale 累积——单位阵亡后 id 残留）
      const aliveIds = new Set([...state.vanguards, ...state.rangers].map((u) => u.id));
      for (const id of [...rec.vanguardIds]) if (!aliveIds.has(id)) rec.vanguardIds.delete(id);
      for (const id of [...rec.rangerIds]) if (!aliveIds.has(id)) rec.rangerIds.delete(id);
      // 借调单位全灭 → sortie 自然消亡
      if (rec.vanguardIds.size === 0 && rec.rangerIds.size === 0) {
        this.coreSorties.delete(key);
        this.sortiePruneCount += 1;
      }
    }
  }

  /** W57 双相轮换治疗槽状态推进（guardHealRotationTwoPhase）：decide 入口每
   *  tick 调一次，在消费侧（Vanguard/Ranger heal-rotation 分支）之前推进 FSM——
   *  patient 相伤员脱离危险血量（HP > HEAL_ROTATION_HP）或 patientPhaseTicks
   *  超时 → 转 relief 相；relief 相 reliefPhaseTicks 冷却到期 → 释放槽。未启用
   *  时 Map 永空，直接 return（零回归）。 */
  private advanceHealRotationSlots(state: TickState): void {
    if (this.config.guardHealRotationTwoPhase !== true) return;
    const patientTicks = this.config.patientPhaseTicks ?? HEAL_ROTATION_HOLD_TICKS;
    const reliefTicks = this.config.reliefPhaseTicks ?? HEAL_ROTATION_RELIEF_TICKS;
    const liveUnits = new Map(state.units.map((unit) => [unit.id, unit] as const));
    for (const [unitType, slot] of this.healRotationSlots) {
      const occupant = liveUnits.get(slot.occupantId);
      // 占用者已阵亡/不存在 → 释放槽（无单位需要继续补满）
      if (occupant === undefined) {
        this.healRotationSlots.delete(unitType);
        continue;
      }
      if (slot.phase === "patient") {
        // 伤员脱离危险血量（HP > 触发阈值）→ 转 relief 冷却（给前伤员继续补满/
        // 让出 Core 格的时间，阻止下一个伤员立即冲入仍被占用的 Core 格）
        const healedAboveTrigger = occupant.hp > HEAL_ROTATION_HP[occupant.unitType];
        const patientTimedOut = state.tick >= slot.phaseEndTick;
        if (healedAboveTrigger || patientTimedOut) {
          this.healRotationSlots.set(unitType, {
            phase: "relief",
            occupantId: slot.occupantId,
            phaseStartTick: state.tick,
            phaseEndTick: state.tick + reliefTicks,
          });
        }
      } else {
        // relief 冷却到期 → 释放槽（下一个伤员可认领）
        if (state.tick >= slot.phaseEndTick) {
          this.healRotationSlots.delete(unitType);
        }
      }
    }
  }

  /** W57 双相轮换治疗槽认领判定（guardHealRotationTwoPhase）：消费侧（Vanguard/
   *  Ranger heal-rotation 分支）调用——返回 true 表示该伤员应走 heal-return（占用
   *  槽或已是当前 patient）；返回 false 表示槽被占用中（另一伤员 patient 相 或
   *  relief 冷却中），本伤员应守位不入槽（one-at-a-time + relief 冷却门控）。
   *  认领副作用：槽空时新建 patient 相，phaseEndTick = tick + patientPhaseTicks。
   *  注意：relief 冷却中即使前占用者本身也不认领——冷却期内槽对所有人关闭，
   *  给前伤员在 Core 格补满/让位移动的时间（防下一个伤员冲入仍被占用的 Core 格）。 */
  private claimHealRotationSlot(unit: UnitSnapshot, state: TickState): boolean {
    const slot = this.healRotationSlots.get(unit.unitType);
    // 槽空 → 认领为 patient 相
    if (slot === undefined) {
      const patientTicks = this.config.patientPhaseTicks ?? HEAL_ROTATION_HOLD_TICKS;
      this.healRotationSlots.set(unit.unitType, {
        phase: "patient",
        occupantId: unit.id,
        phaseStartTick: state.tick,
        phaseEndTick: state.tick + patientTicks,
      });
      return true;
    }
    // patient 相 + 本单位是占用者 → 继续占用（伤员仍在回修路上，advance 未转 relief）
    if (slot.phase === "patient" && slot.occupantId === unit.id) {
      return true;
    }
    // 槽被其他伤员占用（patient 相）或 relief 冷却中（含前占用者）→ 不入槽
    return false;
  }

  /** 斩首配额 sortie 目标选择（W10，sortie-quota-v1）：weakCoreOrderedTargets 全
   *  军事扑同一弱核 → 按家防余量分档借调 1V+2R 编成 sortie，分流不扑同一目标。
   *  单位已编入活跃 sortie → 返回该 sortie 目标；否则尝试加入未满编的既有 sortie；
   *  家防余量 ≥3V+3R → 为下一可用目标新建 sortie 借调；余量不足 → 返回
   *  undefined（单位不扑弱核，fall through 到 prey/scavenge/home，零回归意图）。
   *  只在 config.sortieQuota === true 时调用（调用方保证）；Map 跨 tick sticky。 */
  private sortieTargetFor(
    unit: UnitSnapshot,
    orderedTargets: readonly CoreHuntTarget[],
    state: TickState,
  ): CoreHuntTarget | undefined {
    if (state.core === null) return undefined;
    const maxDist = this.config.sortieMaxHomeDistance ?? SORTIE_MAX_HOME_DISTANCE;
    const sightingTicks = this.config.sortieSightingTicks ?? SORTIE_SIGHTING_TICKS;
    const isFresh = (target: CoreHuntTarget): boolean =>
      state.tick - target.lastSeenTick <= sightingTicks &&
      chebyshev(state.core!.position, target.position) <= maxDist;

    // 1. 单位已编入活跃 sortie → 返回该 sortie 目标（目标仍有效时）
    for (const [key, rec] of this.coreSorties) {
      const member = rec.vanguardIds.has(unit.id) || rec.rangerIds.has(unit.id);
      if (!member) continue;
      const target = orderedTargets.find((t) => cellKey(t.position) === key);
      if (target !== undefined && isFresh(target)) {
        return target;
      }
      // sortie 目标失效 → 退出该 sortie（pruneSorties 下 tick 清记录，此处先脱编）
      rec.vanguardIds.delete(unit.id);
      rec.rangerIds.delete(unit.id);
      break;
    }

    // 2. 加入既有未满编 sortie（补齐 1V+2R 编成）
    for (const [key, rec] of this.coreSorties) {
      const target = orderedTargets.find((t) => cellKey(t.position) === key);
      if (target === undefined || !isFresh(target)) continue;
      if (
        unit.unitType === "VANGUARD" &&
        rec.vanguardIds.size < SORTIE_VANGUARDS_PER_SORTIE
      ) {
        rec.vanguardIds.add(unit.id);
        return target;
      }
      if (
        unit.unitType === "RANGER" &&
        rec.rangerIds.size < SORTIE_RANGERS_PER_SORTIE
      ) {
        rec.rangerIds.add(unit.id);
        return target;
      }
    }

    // 3. 家防余量 ≥3V+3R → 为下一可用目标新建 sortie 借调 1V+2R
    const reserves = this.homeDefenseReserves(state);
    const canBorrow =
      reserves.vanguards >= SORTIE_HOME_VANGUARD_RESERVE &&
      reserves.rangers >= SORTIE_HOME_RANGER_RESERVE;
    if (!canBorrow) return undefined;
    for (const target of orderedTargets) {
      if (target.source !== "CORE") continue;
      const key = cellKey(target.position);
      if (this.coreSorties.has(key)) continue;
      if (!isFresh(target)) continue;
      const rec: SortieRecord = {
        startedTick: state.tick,
        sightingTick: target.lastSeenTick,
        vanguardIds: new Set<string>(),
        rangerIds: new Set<string>(),
      };
      if (unit.unitType === "VANGUARD") rec.vanguardIds.add(unit.id);
      else rec.rangerIds.add(unit.id);
      this.coreSorties.set(key, rec);
      return target;
    }

    // 4. 无可用 sortie → 不扑弱核（调用方 fall through 到其他行为）
    return undefined;
  }

  /** 攻坚集结位（rally-assault-v1）：敌核外圈 Chebyshev RALLY_DISTANCE 的 8 方位
   *  点，按"距我方 Core 最近"排序（从我方一侧接近，不绕敌后），第一个非障碍/非
   *  资源点作为集结位；全堵回退敌核格（兜底直接攻坚）。确定性（同输入同输出）。 */
  private rallyPoint(target: Position, home: Position, obstacles: ReadonlySet<string>, resourceCells: ReadonlySet<string>): Position {
    const offsets: ReadonlyArray<readonly [number, number]> = [
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [1, -1], [-1, 1], [-1, -1],
    ];
    const candidates = offsets
      .map(([dx, dy]) => [target[0] + dx * RALLY_DISTANCE, target[1] + dy * RALLY_DISTANCE] as Position)
      .sort((a, b) => manhattan(a, home) - manhattan(b, home));
    for (const candidate of candidates) {
      if (obstacles.has(cellKey(candidate))) continue;
      if (resourceCells.has(cellKey(candidate))) continue;
      return candidate;
    }
    return target;
  }

  /** 攻坚组是否"已到齐"（rally-assault-v1 历史全局门）：敌核外圈集结区
   *  （≤RALLY_DISTANCE+RALLY_ARRIVE_RADIUS）内军事单位 ≥RALLY_READY_COUNT，或
   *  首到后超时强制压上（防某单位被障碍卡住导致永久空等）。目标切换/被重新
   *  目击时重置 ready。战术小队关闭（或单位无编成）时使用，零回归。 */
  private globalRallyReady(target: Position, key: string, state: TickState): boolean {
    const arrived = [...state.vanguards, ...state.rangers].filter(
      (u) => chebyshev(u.position, target) <= RALLY_DISTANCE + RALLY_ARRIVE_RADIUS,
    ).length;
    const rec = this.rallyTargets.get(key);
    if (rec === undefined) {
      this.rallyTargets.set(key, { ready: false, firstArriveTick: -1 });
      return false;
    }
    if (arrived >= RALLY_READY_COUNT) {
      rec.ready = true;
      return true;
    }
    if (rec.firstArriveTick === -1 && arrived > 0) rec.firstArriveTick = state.tick;
    if (rec.firstArriveTick !== -1 && state.tick - rec.firstArriveTick >= RALLY_TIMEOUT_TICKS) {
      rec.ready = true;
      return true;
    }
    return rec.ready;
  }

  /** 攻坚组是否"已到齐"（tactical-squads-v1 小队版）：按 squad 独立门——本 squad
   *  全部存活成员到齐（arrived ≥ members.length）即放行本 squad，或本 squad 首到
   *  后 RALLY_TIMEOUT_TICKS 超时强制压上。记录键 = `${squad.id}@${targetKey}`，
   *  不同 squad 的到齐/超时互不影响（一个 squad 到齐不放行另一个）。 */
  private squadRallyReady(target: Position, targetKey: string, state: TickState, squad: TacticalSquad): boolean {
    const members = [...squad.vanguardIds, ...squad.rangerIds];
    if (members.length === 0) return true;
    const memberPositions = new Map<string, Position>();
    for (const u of state.vanguards) memberPositions.set(u.id, u.position);
    for (const u of state.rangers) memberPositions.set(u.id, u.position);
    const arrived = members.filter((id) => {
      const position = memberPositions.get(id);
      return position !== undefined && chebyshev(position, target) <= RALLY_DISTANCE + RALLY_ARRIVE_RADIUS;
    }).length;
    const key = `${squad.id}@${targetKey}`;
    const rec = this.rallyTargets.get(key);
    if (rec === undefined) {
      // 首个成员调用即评估到齐/超时（不因"建记录先返回 false"晚一 tick 放行——
      // ranger 先于 vanguard 决策时同 squad 到齐也须同 tick 放行）。
      this.rallyTargets.set(key, { ready: false, firstArriveTick: -1 });
    }
    const record = this.rallyTargets.get(key)!;
    if (arrived >= members.length) {
      record.ready = true;
      return true;
    }
    if (record.firstArriveTick === -1 && arrived > 0) record.firstArriveTick = state.tick;
    if (record.firstArriveTick !== -1 && state.tick - record.firstArriveTick >= RALLY_TIMEOUT_TICKS) {
      record.ready = true;
      return true;
    }
    return record.ready;
  }

  /** 攻坚组是否"已到齐"（rally-assault-v1）：战术小队开启时按单位所属 squad
   *  独立门（squad 到齐/超时才放行，一个 squad 到齐不放行另一个）；关闭或单位
   *  无编成时回落历史全局门（≥RALLY_READY_COUNT 或全局首到超时，零回归）。 */
  private rallyReady(target: Position, key: string, state: TickState, unit: UnitSnapshot): boolean {
    if (this.config.tacticalSquads === true) {
      const squad = this.squadOf(unit.id);
      if (squad !== undefined) return this.squadRallyReady(target, key, state, squad);
    }
    return this.globalRallyReady(target, key, state);
  }

  /** 攻坚集结状态随核心目标变化复位（rally-assault-v1，P2 2026-08-10）：
   *  rallyTargets 只 set 不 delete（globalRallyReady/squadRallyReady 首次
   *  命中即建 key）→ 目标遗忘/更换后旧 key 永久残留（长局无界增长）；且
   *  ready 置真后永不复位 → 换目标后旧 ready 残留（新集结直接压上不再重新
   *  集结）。主目标格变化 → 旧 key 复位（ready=false 需重新集结，计时重置）。
   *  目标格相同（同格重标）→ 不动（ready 保留；旧集结计时继续走，配合
   *  dropRallyTargetsAt 的遗忘删除覆盖同格重种场景）。 */
  private reconcileRallyTargets(): void {
    const target = this.currentHuntTarget();
    const huntKey = target === null ? null : cellKey(target.position);
    if (huntKey === this.lastRallyHuntKey) return; // 主目标未变
    const prevKey = this.lastRallyHuntKey;
    this.lastRallyHuntKey = huntKey;
    if (prevKey === null) return;
    // 目标格变化：旧集结作废，需重新集结
    const rec = this.rallyTargets.get(prevKey);
    if (rec !== undefined) {
      rec.ready = false;
      rec.firstArriveTick = -1;
    }
  }

  /** 核心被遗忘（forgetCoreHuntAt）时删除对应 rallyTargets key（P2 2026-08-10）：
   *  目标已被遗忘 → 该格的集结记录全部作废删除（全局 key + squad key
   *  `${squad.id}@${targetKey}`），防旧 key 永久残留（无界增长）。 */
  private dropRallyTargetsAt(targetCell: string): void {
    this.rallyTargets.delete(targetCell);
    for (const key of [...this.rallyTargets.keys()]) {
      if (key.endsWith(`@${targetCell}`)) this.rallyTargets.delete(key);
    }
  }

  private huntSweepPoint(target: Position, index: number, reach: number): Position {
    if (reach > HUNT_SWEEP_RADIUS) return target;
    const [dx, dy] = DENSE_DELTAS[(index * 3 + 7) % DENSE_DELTAS.length]!;
    return [target[0] + dx * 2, target[1] + dy * 2];
  }

  /** W62 环形扇区扫荡前沿航点（2026-08-09，竞品 `_assault_frontier_target`
   *  :6955 对照）：全队共享前沿搜索目标——半径在 MIN→MAX 间振荡（近-远-近
   *  循环覆盖全纵深）+ 扇区索引在 8 方位间旋转（覆盖全方向）。全员到齐门控
   *  （所有攻坚单位 ≤WAYPOINT_REACHED_RADIUS 才推进下一航点），防单位散开各自
   *  升环（per-unit patrolRing 的缺陷）。返回当前航点坐标（调用方 stepToward）。
   *  与 rally-assault 不同：rally 是压已知敌 Core 前的集结点，W62 是搜索阶段的
   *  前沿航点几何——阶段不同、门控语义不同（rally ≥3 到齐或超时 vs W62 全员到齐）。 */
  private assaultFrontierTarget(state: TickState, obstacles: ReadonlySet<string>): Position | null {
    const home = state.core?.position ?? null;
    if (home === null) return null;
    const minRadius = this.config.assaultSweepMinRadius ?? ASSAULT_SWEEP_MIN_RADIUS;
    const maxRadius = this.config.assaultSweepMaxRadius ?? ASSAULT_SWEEP_MAX_RADIUS;
    const reachRadius = this.config.assaultSweepWaypointReachedRadius
      ?? ASSAULT_SWEEP_WAYPOINT_REACHED_RADIUS;
    const radiusSpan = maxRadius - minRadius;
    const halfTurn = Math.floor(ASSAULT_SWEEP_SECTOR_OFFSETS.length / 2);
    const cycleSteps = radiusSpan * 2 + halfTurn * 2;
    const phase = this.assaultSweepStep % cycleSteps;
    // 半径振荡：MIN→MAX（phase ≤ span）→ MAX 停留半圈 → MAX→MIN → MIN 停留半圈。
    let radius: number;
    if (phase <= radiusSpan) {
      radius = minRadius + phase;
    } else if (phase <= radiusSpan + halfTurn) {
      radius = maxRadius;
    } else if (phase <= radiusSpan * 2 + halfTurn) {
      radius = maxRadius - (phase - radiusSpan - halfTurn);
    } else {
      radius = minRadius;
    }
    // 扇区索引旋转（覆盖全方向）。
    const sectorIndex = phase % ASSAULT_SWEEP_SECTOR_OFFSETS.length;
    const [signX, signY] = ASSAULT_SWEEP_SECTOR_OFFSETS[sectorIndex]!;
    // 对角扇区：x 取半径一半、y 取余量（竞品几何近似，保证 8 方位整数格可达）。
    let xDistance: number;
    let yDistance: number;
    if (signX !== 0 && signY !== 0) {
      xDistance = Math.floor(radius / 2);
      yDistance = radius - xDistance;
    } else {
      xDistance = signX !== 0 ? radius : 0;
      yDistance = signY !== 0 ? radius : 0;
    }
    const arcAnchor: Position = [home[0] + signX * xDistance, home[1] + signY * yDistance];
    // 全员到齐门控：所有攻坚单位（Vanguard+Ranger）到达当前航点 ≤reachRadius
    // 才推进下一航点（防散开各自升环）；空队（无军事单位）= 不推进（防 step
    // 在无单位时空转）。同 tick 防多次推进（assaultSweepLastAdvanceTick）。
    const assaultUnits = [...state.vanguards, ...state.rangers];
    const target = arcAnchor; // 简化：航点 = 扇区锚点（竞品在锚点 Chebyshev 4 内
    // 取非障碍候选 + 评分；这里取锚点本身，stepToward 绕障已处理硬块）。
    const allArrived =
      assaultUnits.length > 0
      && assaultUnits.every((u) => chebyshev(u.position, target) <= reachRadius)
      && this.assaultSweepLastAdvanceTick !== state.tick;
    if (allArrived) {
      this.assaultSweepStep += 1;
      this.assaultSweepLastAdvanceTick = state.tick;
    }
    return target;
  }

  /** 远端军事回援（remoteReinforce 候选，竞品 "敌方战斗单位已经进入 Core
   *  防区时，所有非守家单位跳过集结等待并立即回援"）：可见敌方**战斗单位**
   * （VANGUARD/RANGER，非 WORKER/CORE）进入 Core 防区（12 =
   *  THREAT_FALLBACK_RADIUS，与 threat 评估/worker 召回同口径）→ 远端军事
   *  单位应回 Core 守位。守家圈内（≤4：Vanguard 3 格外层屏 / Ranger 2 格
   *  内层屏）单位已是守家队，走既有防御逻辑（邻接 SWEEP/射程射击/威胁轴
   *  守位）——回援只针对远端单位。触发（homeThreat）刷新回援窗口
   * （+REINFORCE_HOLD_TICKS）；窗口内即使敌人闪失仍保持回援（防抖动）。 */
  private shouldReinforce(
    state: TickState,
    unit: UnitSnapshot,
    enemies: readonly VisibleEntity[],
  ): boolean {
    if (this.config.remoteReinforce !== true || state.core === null) return false;
    if (manhattan(unit.position, state.core.position) <= REINFORCE_HOME_RING) return false;
    // 快攻防御（raid-defense-v1，2026-08-07）：警戒半径从 12（确认接触）放宽到
    // 18——实测敌军战斗单位（可见或 12 tick 记忆内）更早进入防区即回援，不等
    // 小股部队贴脸才动（用户裁决"别人可以只派一些人来打"）。
    const watchRadius =
      this.config.raidDefense === true
        ? (this.config.raidWatchRadius ?? RAID_UNIT_WATCH_RADIUS)
        : THREAT_RECALL_DISTANCE;
    const homeThreat =
      enemies.some(
        (enemy) =>
          enemy.kind === "UNIT" &&
          enemy.unitType !== "WORKER" &&
          manhattan(enemy.position, state.core!.position) <= watchRadius,
      ) ||
      (this.config.raidDefense === true && this.raidUnitDistance(state) <= watchRadius);
    if (homeThreat) this.reinforceUntil.set(unit.id, state.tick + REINFORCE_HOLD_TICKS);
    return (this.reinforceUntil.get(unit.id) ?? 0) >= state.tick;
  }

  /** 资源分配/巡逻最大距离（生产回流 99b4ba2，threatRecall/raidDefense/
   *  threatBreakout 统一口径）：召回激活时缩到守家圈 RECALL_PATROL_RADIUS，
   *  否则不限制（Infinity）。DeterministicPlanner.decide() 用其过滤 Hungarian
   *  候选资源格（threat recall 过滤远资源），workerDecision 用其收缩巡逻半径
   *  ——单一事实源，防双实现漂移。 */
  resourceAssignmentMaxDistanceFromCore(state: TickState): number {
    const home = state.core?.position ?? null;
    if (home === null) return Number.POSITIVE_INFINITY;
    // 威胁召回（threatRecall，v0.3 实验）：12 格内可见敌（确认接触）时 worker
    // 巡逻/探索半径缩到守家圈（RECALL_PATROL_RADIUS），不放远探/远采。
    // BREAKOUT 全面收缩（threatBreakout，v0.3 实验）：多轴包围（无逃逸方向）
    // 时同样缩家——被包围时外出即送死，等包围解除再恢复。
    const recallActive =
      this.config.threatRecall === true &&
      (state.visibleEnemies.some(
        // 只对敌方战斗单位（Vanguard/Ranger）召回（2026-08-08，t4 被 majorcycle
        // 敌核 + 1 worker 压制 25+ tick 全体停产实证）：敌核是攻击目标、敌方
        // worker 无攻击不升级核心级威胁——与 threat.ts 同款语义，worker 采矿
        // 路径仍由 threatMap 避开敌占格。
        (enemy) =>
          enemy.kind === "UNIT" &&
          enemy.unitType !== undefined &&
          enemy.unitType !== "WORKER" &&
          home !== null &&
          manhattan(enemy.position, home) <= THREAT_RECALL_DISTANCE,
      ) ||
        // 快攻防御（raid-defense-v1，2026-08-07）：警戒半径放宽到 18——小股
        // 部队更早进入防区即召回 worker 缩家圈（不等贴脸）。
        (this.config.raidDefense === true &&
          home !== null &&
          this.raidUnitDistance(state) <= (this.config.raidWatchRadius ?? RAID_UNIT_WATCH_RADIUS)));
    const breakoutActive =
      this.config.threatBreakout === true && this.currentThreat?.level === "BREAKOUT";
    const band = this.config.migrationWorkerBand;
    const leash = this.config.workerLeash;
    // worker-leash-v1：非威胁期基础拴绳（undefined = 不限制，零回归）。
    // recall/breakout 优先（守家圈更紧），leash 作为非威胁期的经济距离上限。
    let base: number;
    if (recallActive || breakoutActive) {
      base = RECALL_PATROL_RADIUS;
    } else if (leash !== undefined) {
      base = leash;
    } else {
      base = Number.POSITIVE_INFINITY;
    }
    // 迁移期 worker 集结带（migration-system-v1 §3.3）：min 叠加既有权威上限。
    return band === undefined ? base : Math.min(base, band);
  }

  /** 快攻单位压力（raid-defense-v1，2026-08-07）：敌方战斗单位（Vanguard/Ranger）
   *  距我方 Core 的最近 Manhattan 距离——可见敌优先，其次 12 tick 记忆内目击
   *  （侦察视野外的接近单位由 worker 巡逻记忆补全）。无 → Infinity。 */
  private raidUnitDistance(state: TickState): number {
    const core = state.core?.position ?? null;
    if (core === null) return Number.POSITIVE_INFINITY;
    let min = Number.POSITIVE_INFINITY;
    for (const enemy of state.visibleEnemies) {
      if (enemy.kind === "UNIT" && enemy.unitType !== "WORKER") {
        min = Math.min(min, manhattan(enemy.position, core));
      }
    }
    for (const hint of this.world.enemyHints(RAID_SIGHTING_FRESH_TICKS)) {
      if (hint.kind === "UNIT" && hint.unitType !== undefined && hint.unitType !== "WORKER") {
        min = Math.min(min, manhattan(hint.position, core));
      }
    }
    // 入侵观察（2026-08-08，core-threat-watch-v1）：盘踞/间歇可见的敌战斗单位
    // 在长 TTL 观察内（当前不可见）——短记忆（RAID_SIGHTING_FRESH_TICKS）会漏，
    // 回援必须覆盖"敌贴脸 camp 但 6-12 tick 未目击"的情况（官方 guide：敌方
    // 战斗单位进入 Core 防区 → 非守家单位立即回援）。
    if (this.config.coreThreatWatch === true) {
      const watchTicks = this.config.coreThreatWatchTicks ?? CORE_THREAT_WATCH_TICKS;
      for (const watch of this.world.coreWatchTargets(watchTicks)) {
        if (watch.kind !== "UNIT" || watch.unitType === undefined || watch.unitType === "WORKER") continue;
        min = Math.min(min, manhattan(watch.position, core));
      }
    }
    return min;
  }

  /** 核心外圈守位点（core-clearance-v1，2026-08-07）：距核心 Chebyshev 2 的
   *  16 方位点（DENSE_DELTAS×2），按单位序号轮转选第一个非障碍点——homeCell
   *  四邻全堵时军事守位回退到外圈而非核心格（核心格容量 2 含 Core，是 worker
   *  卸货唯一通道，被军事占 = 卸货死锁）。极端全堵返回核心自身（配合疏散分支，
   *  站在核心格的单位每 tick 先被移走，兜底只影响回援目标不造成滞留）。 */
  private coreGuardFallback(core: Position, obstacles: ReadonlySet<string>, index: number): Position {
    for (let k = 0; k < DENSE_DELTAS.length; k += 1) {
      const [dx, dy] = DENSE_DELTAS[(index * 3 + k) % DENSE_DELTAS.length]!;
      const pos: Position = [core[0] + dx * 2, core[1] + dy * 2];
      if (!obstacles.has(cellKey(pos))) return pos;
    }
    return core;
  }

  /** fog-of-war shooting gate（2026-08-10）：检查射击线中间格是否全部已观测。
   *  lineBlocked 只查障碍集——不在障碍集中的格被当作空地，但"从未进入友方
   *  视野的迷雾格"也不在障碍集中 → 误判可射击 → 引擎知道是障碍 → SHOT_MISSED。
   *  此方法对射击线每个中间格查 isCellObserved，任一未观测（迷雾）→ true（阻断）。
   *  t1 实证：543 SHOT_MISSED / 65 SHOT_HIT（10.7% 命中率），根因之一即迷雾盲射。 */
  private shootingLineObscured(from: Position, to: Position): boolean {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const steps = Math.max(Math.abs(dx), Math.abs(dy));
    if (steps <= 1) return false;
    const sx = dx === 0 ? 0 : dx / steps;
    const sy = dy === 0 ? 0 : dy / steps;
    if (!Number.isInteger(sx) || !Number.isInteger(sy)) return true;
    for (let i = 1; i < steps; i += 1) {
      if (!this.world.isCellObserved([from[0] + sx * i, from[1] + sy * i])) return true;
    }
    return false;
  }

  /** _vacate_core_for_logistics egress 评分（Pattern 2, 2026-08-10，竞品
   *  `_vacate_core_for_logistics` :3417-3444 对照）：Core 格被占时让位 worker
   *  的出口选择——不仅看"非障碍"，还看 onward_open（候选格四邻开放数，防进
   *  死胡同再卡 → 横跳振荡）+ threat（候选格周围敌数，远敌优先）+ direction
   *  rank（确定性 tiebreaker）。统一 spawn-yield / worker_clear_core /
   *  worker_clear_core_empty 三套碎片的出口链。 */
  private egressExit(
    home: Position,
    obstacles: ReadonlySet<string>,
    occupancy: ReadonlyMap<string, number>,
    enemies: readonly VisibleEntity[],
    index: number,
  ): Position | null {
    const enemyCells = new Set(enemies.map((enemy) => cellKey(enemy.position)));
    const cardinals: readonly { readonly delta: readonly [number, number]; readonly rank: number }[] = [
      { delta: [0, -1], rank: 0 },
      { delta: [1, 0], rank: 1 },
      { delta: [0, 1], rank: 2 },
      { delta: [-1, 0], rank: 3 },
    ];
    const candidates: { readonly negOnwardOpen: number; readonly enemyCount: number; readonly rank: number; readonly position: Position }[] = [];
    for (const { delta, rank } of cardinals) {
      const candidate: Position = [home[0] + delta[0], home[1] + delta[1]];
      const candidateKey = cellKey(candidate);
      if (obstacles.has(candidateKey)) continue;
      if (enemyCells.has(candidateKey)) continue;
      if ((occupancy.get(candidateKey) ?? 0) >= 2) continue;
      let onwardOpen = 0;
      let nearbyEnemies = 0;
      for (const { delta: onwardDelta } of cardinals) {
        const onward: Position = [candidate[0] + onwardDelta[0], candidate[1] + onwardDelta[1]];
        const onwardKey = cellKey(onward);
        if (samePosition(onward, home)) continue;
        if (obstacles.has(onwardKey)) continue;
        if (enemyCells.has(onwardKey)) { nearbyEnemies += 1; continue; }
        onwardOpen += 1;
      }
      candidates.push({ negOnwardOpen: -onwardOpen, enemyCount: nearbyEnemies, rank, position: candidate });
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) =>
        a.negOnwardOpen - b.negOnwardOpen
        || a.enemyCount - b.enemyCount
        || a.rank - b.rank,
      );
      return candidates[0]!.position;
    }
    return this.coreGuardFallback(home, obstacles, index);
  }

  /** 邻近敌核心（raid-defense-v1，2026-08-07）：coreHuntTargets 中 CORE 目击
   *  （sticky 记忆）距我方 Core ≤ raidCoreRadius → 站立威胁——即使该玩家从不
   *  进攻，也可能随时派小股来偷家/骚扰（用户裁决"别人可以只派一些人来打"）。
   *  无 CORE 目击/超半径 → false（零回归）。 */
  private nearbyEnemyCore(state: TickState): boolean {
    const core = state.core?.position ?? null;
    if (core === null) return false;
    const radius = this.config.raidCoreRadius ?? RAID_CORE_RADIUS;
    return this.world.coreHuntTargets().some(
      (target) => target.source === "CORE" && chebyshev(target.position, core) <= radius,
    );
  }

  /** 信标夺取（beaconGrab 候选，官方 Champion Beacon 机制对齐）：返回本单位的
   *  信标任务——"fetch" = 前往拾取（仅最近 Vanguard/Ranger 获得，防全军涌向
   *  信标）；"return" = 已持标，回 Core 守位（持标 buff 属于本租户，载者不能
   *  带着信标满图跑）。信标 CARRIED 且不是我们 → 不争夺（敌标不打）。信标距
   *  Core 超 beaconGrabMaxDist → 远征放弃。 */
  private beaconMission(
    state: TickState,
    unit: UnitSnapshot,
  ): "fetch" | "return" | null {
    if (this.config.beaconGrab !== true) return null;
    const beacon = state.beacon;
    if (beacon.status === "CARRIED") {
      return beacon.carrierId === unit.id ? "return" : null;
    }
    // 追移动信标 = 追敌方载者（t2 生产实证 2026-08-08：信标被 jerkman 核心
    // 带着沿 y=0 东移，vanguard 单骑北上追标 = 送人头）。近 10 tick 信标移动过
    // （≥2 个不同位置）→ 视为敌方携带/漂移，不单独 fetch；等信标静止（真掉落）
    // 再拾取（静止 GROUND 信标 = 无主可拿）。
    if (this.world.beaconMoving(BEACON_MOVE_WINDOW_TICKS)) return null;
    // 信标在已知敌核心附近（敌方基地/战区）→ 不单独 fetch：单骑深入送死
    // （t2 生产实证：信标即 jerkman 核心所在地，小队埋伏）。由 militaryHunt
    // 攻坚处理；敌核心被摧毁后我方单位在格上经主循环 PICKUP_BEACON 自动拾取。
    if (this.world.coreHuntTargets().some(
      (target) => chebyshev(target.position, beacon.position) <= BEACON_CONTEST_RADIUS,
    )) {
      return null;
    }
    if (state.core === null) return null;
    if (chebyshev(beacon.position, state.core.position) > (this.config.beaconGrabMaxDist ?? BEACON_GRAB_DEFAULT_MAX_DIST)) {
      return null;
    }
    // 指定最近 Vanguard（抗揍、护标），无 Vanguard 才用 Ranger——按距离升序
    // + id tie-break 确定性。非指定单位不抢（防多单位同时涌向信标）。
    const vanguardPool = [...state.vanguards]
      .map((u) => ({ u, d: chebyshev(u.position, beacon.position) }))
      .sort((a, b) => a.d - b.d || a.u.id.localeCompare(b.u.id));
    const rangerPool = [...state.rangers]
      .map((u) => ({ u, d: chebyshev(u.position, beacon.position) }))
      .sort((a, b) => a.d - b.d || a.u.id.localeCompare(b.u.id));
    const designee = this.pickBeaconFetchDesignee(state, beacon, vanguardPool, rangerPool);
    if (designee === null) return null;
    // W61（beacon-commitment-v1）：记录本轮设计者（跨 tick 持久，防下 tick
    // 因距离微差换设计者 → 中途放弃信标）。
    this.beaconFetchDesigneeId = designee.u.id;
    if (designee.u.id !== unit.id) return null;
    return "fetch";
  }

  /**
   * W61（beacon-commitment-v1，竞品 "信标距离迟滞带 + 进度权重" 对照）：
   * beacon fetch 设计者选择——上一轮设计者（仍在候选池）的距离减去迟滞带
   * + 进度权重，防每 tick 因距离微差换设计者（中途放弃信标 → 取标进度全废）。
   *
   * 评分：adjusted = distance - hysteresisBonus - progressBonus
   * - hysteresisBonus：候选 = 上一轮设计者 → 减 `beaconCommitmentHysteresis`
   *   （新候选必须比当前设计者近 > 迟滞带才能替换，防抖动）。
   * - progressBonus：候选 = 上一轮设计者 → 减 `progressWeight * (1 - d/maxDist)`
   *   （越接近信标 = 进度越高，越难被替换——防中途放弃信标）。
   *
   * beaconCommitment 关闭 / 字段缺省 → 纯最近距离选设计者（零回归）。
   */
  private pickBeaconFetchDesignee(
    state: TickState,
    beacon: TickState["beacon"],
    vanguardPool: readonly { readonly u: UnitSnapshot; readonly d: number }[],
    rangerPool: readonly { readonly u: UnitSnapshot; readonly d: number }[],
  ): { u: UnitSnapshot; d: number } | null {
    void state; // 闸门已在 beaconMission 前置完成，此处仅做设计者选择
    void beacon;
    const pool = vanguardPool.length > 0 ? vanguardPool : rangerPool;
    if (pool.length === 0) return null;
    const commitmentOn = this.config.beaconCommitment === true;
    const hysteresis = commitmentOn ? (this.config.beaconCommitmentHysteresis ?? 0) : 0;
    const progressWeight = commitmentOn ? (this.config.beaconCommitmentProgress ?? 0) : 0;
    const maxDist = this.config.beaconGrabMaxDist ?? BEACON_GRAB_DEFAULT_MAX_DIST;
    const previousDesigneeId = this.beaconFetchDesigneeId;
    let best: { u: UnitSnapshot; d: number; adjusted: number } | null = null;
    for (const candidate of pool) {
      let adjusted = candidate.d;
      if (
        commitmentOn &&
        previousDesigneeId !== null &&
        candidate.u.id === previousDesigneeId
      ) {
        adjusted -= hysteresis;
        const progress = maxDist > 0 ? Math.max(0, 1 - candidate.d / maxDist) : 0;
        adjusted -= progressWeight * progress;
      }
      if (best === null || adjusted < best.adjusted || (adjusted === best.adjusted && candidate.u.id.localeCompare(best.u.id) < 0)) {
        best = { u: candidate.u, d: candidate.d, adjusted };
      }
    }
    return best === null ? null : { u: best.u, d: best.d };
  }
  /** 信标护送（beacon-escort，2026-08-08 军事负责人信标预案，A/B 证据
   *  beacon-escort-ab.mts）：beaconGrab 开启时，除取标设计者外**最近**的
   *  Vanguard 担任护送者，贴身影护设计者/载者（保持 ≤2 格，防止单骑深入
   *  敌游荡区被射爆——A/B：载者阵亡掉标 2/3→0、取标干净 3/3、军事阵亡持平
   *  （36 vs 35）；护送只护"取"不护"回"（载者持标盾 buff 抗揍，回程跟入
   *  敌射程反多送目标——escort-return 已否决）。
   *  设计者本人不护送（其 fetch/return 由 beaconMission 处理）；多护送者
   *  防全军涌向信标（与 fetch 单设计者同构）。beaconGrab 关闭 = 零回归。 */
  private beaconEscortMission(
    state: TickState,
    unit: UnitSnapshot,
  ): { readonly kind: "escort-fetch"; readonly designeePos: Position } | null {
    if (this.config.beaconGrab !== true) return null;
    if ((this.config as { beaconEscort?: boolean }).beaconEscort === false) return null;
    const beacon = state.beacon;
    const unitById = new Map([...state.vanguards, ...state.rangers].map((u) => [u.id, u]));
    let designeeId: string | null = null;
    if (beacon.status === "CARRIED") {
      // 已持标：不护送回程——载者持标盾 buff（5→10）抗揍，护送者跟入敌射程
      // 反而多送一个目标（A/B 实证：escort-return 让军事存活 6.7→2.0）。
      // 拾取完成后护送自动解散，各回本位（守家/巡逻）。
      return null;
    } else {
      // GROUND：与 beaconMission 同闸门（防追移动标/敌核心战区/远征）
      if (this.world.beaconMoving(BEACON_MOVE_WINDOW_TICKS)) return null;
      if (this.world.coreHuntTargets().some(
        (target) => chebyshev(target.position, beacon.position) <= BEACON_CONTEST_RADIUS,
      )) return null;
      if (state.core === null) return null;
      if (chebyshev(beacon.position, state.core.position) > (this.config.beaconGrabMaxDist ?? BEACON_GRAB_DEFAULT_MAX_DIST)) return null;
      const vanguardPool = [...state.vanguards]
        .map((u) => ({ u, d: chebyshev(u.position, beacon.position) }))
        .sort((a, b) => a.d - b.d || a.u.id.localeCompare(b.u.id));
      const rangerPool = [...state.rangers]
        .map((u) => ({ u, d: chebyshev(u.position, beacon.position) }))
        .sort((a, b) => a.d - b.d || a.u.id.localeCompare(b.u.id));
      // W61（beacon-commitment-v1）：护送者跟随 beaconMission 选定的设计者
      // （含迟滞 + 进度权重），而非自行重算最近——保持 fetch/escort 设计者
      // 一致（否则 W61 改设计者后护送者会跟错人）。beaconMission 在 decide
      // 中先于本方法调用并已写入 this.beaconFetchDesigneeId；若该 id 不在候选
      // 池（首 tick/旧设计者已不在）→ 回落 pickBeaconFetchDesignee 重选。
      let designee: { u: UnitSnapshot; d: number } | undefined = vanguardPool[0] ?? rangerPool[0];
      const storedId = this.beaconFetchDesigneeId;
      if (storedId !== null) {
        const stored = [...vanguardPool, ...rangerPool].find((c) => c.u.id === storedId);
        if (stored !== undefined) designee = stored;
      }
      if (designee === undefined) {
        const picked = this.pickBeaconFetchDesignee(state, beacon, vanguardPool, rangerPool);
        designee = picked === null ? undefined : picked;
      }
      if (designee === undefined) return null;
      if (designee.u.id === unit.id) return null;
      designeeId = designee.u.id;
    }
    const designeePos = unitById.get(designeeId)?.position;
    if (designeePos === undefined) return null;
    // 护送者 = 距设计者最近的另一 Vanguard（抗揍近战；Ranger 纸脆不护送，
    // A/B squad2v1r 中间值：Ranger 上前的护载收益被其高阵亡抵消）。
    const escorts = [...state.vanguards]
      .filter((u) => u.id !== designeeId)
      .sort((a, b) => chebyshev(a.position, designeePos) - chebyshev(b.position, designeePos) || a.id.localeCompare(b.id));
    if (escorts.length === 0 || escorts[0].id !== unit.id) return null;
    return { kind: "escort-fetch", designeePos };
  }

  decide(input: SafetyPlannerInput): Plan {
    const { state } = input;
    // 旧核验证协议（2026-08-08，ref 对齐）：DESTRUCTION_PARTICIPATION（CORE）
    // 事件 = 敌核心被摧毁强信号 → 立即删除记忆（军事不再打空城）。比清扫确认
    // 更快更准：清扫确认要等 2 次视野覆盖，事件是服务器结算的直接证据。
    for (const event of state.events) {
      if (
        event.eventType === "DESTRUCTION_PARTICIPATION" &&
        (event.reasonCode === "CORE" || event.reasonCode === "ATTACK") &&
        event.position !== undefined
      ) {
        this.world.forgetCoreHuntAt(event.position);
        // 核心被遗忘 → 该格集结记录一并清理（P2：rallyTargets 只 set 不
        // delete，旧目标 key 永久残留导致无界增长）。
        this.dropRallyTargetsAt(cellKey(event.position));
        // 同步清理 enemyMemory（pressure_memory/ranger_memory_shot 读它）——
        // 死核残留让 Ranger 对死核格空放枪（该格常站着己方 Vanguard，观感像
        // 打友军）、Vanguard 全吸到死核格 capacity_wait（t1 69640 拆核实证）。
        this.world.forgetEnemyCoreAt(event.position, event.targetId);
      }
    }
    // 攻坚集结状态随核心目标变化复位（P2）：目标格变化 → 旧 key 的 ready
    // 置 false（需重新集结，不继承旧目标的 ready）；目标格相同 → 保留 ready
    // 但重置集结计时。配合上面 forget 时的 key 删除，rallyTargets 不再
    // 无界增长。
    this.reconcileRallyTargets();
    this.effectivePolicy = input.policy ?? null;
    // focusRegion 防呆（生产实测 2026-08-05）：policy 层曾输出 [1500,1500]/
    // [-1500,1500]/[0,0] 等不可达远点，全部 worker 被 go_focus 直线支走 → 0 采集、
    // 经济冻结、无法补员/产兵。聚焦区必须是 Core 附近的可探索近程区域：以 Core
    // 为圆心超 maxFocusDistance 的焦点视为无效，统一回退巡逻（覆盖 worker/vanguard/
    // ranger 的全部 focus 消费点）。
    const focus = this.effectivePolicy?.focusRegion ?? null;
    const home = state.core?.position ?? null;
    if (focus !== null && home !== null && this.effectivePolicy !== null && chebyshev(home, focus) > this.config.maxFocusDistance) {
      this.effectivePolicy = { ...this.effectivePolicy, focusRegion: null };
    }
    // 攻坚权威性（2026-08-07 修复）：config.aggression === "aggressive"（变体声明，
    // 如 strike-core-v1）时**恒 aggressive**——policy 只能把它从 defensive 升到
    // aggressive，不能反向覆盖（否则 LLM 策略层翻烙饼到 harvest 会把攻坚掐掉，
    // t1 生产实证：policy 在 aggressive/harvest 间每 32 tick 翻转，8 万 tick 局
    // 里 aggressive 变体形同虚设）。无 policy 时用 config 默认。
    this.effectiveAggression =
      input.policy !== undefined
        ? this.config.aggression === "aggressive" || aggressionOf(input.policy) === "aggressive"
          ? "aggressive"
          : "defensive"
        : (this.config.aggression ?? "defensive");
    this.effectiveWorkerTarget = input.policy?.workerTarget ?? this.config.workerTarget;
    // C2 RECOVERY（竞品 lifecycle overlay 对照，2026-08-07）：Core 重生 =
    // 全新 UUID 替换（引擎 P12 respawn：CORE_DESTROYED + CORE_RESPAWNED，
    // 新 Core 20-30 格重生 + 全新 Worker）。旧追击积分/巡逻扇区基于旧 Core
    // 坐标系，重生后失真 → 先清战场记忆再 observe（observe 用新 Core 位置
    // 写入正确记忆）。绝对坐标地图事实（障碍/资源/chunk）保留。正常对局
    // Core id 不变 → 零变化（生产 t1/t2 无对手不重生，零回归）。
    if (state.core !== null && this.lastCoreId !== null && state.core.id !== this.lastCoreId) {
      const cleared = this.world.clearBattlefieldMemory();
      this.coreRecoveryCount += 1;
      this.recoveryLog.push(`tick ${state.tick}: core ${this.lastCoreId.slice(0, 8)} → ${state.core.id.slice(0, 8)}，清战场记忆 ${cleared} 条`);
    }
    if (state.core !== null) this.lastCoreId = state.core.id;
    this.world.observe(state);
    const rangerIds = new Set(state.rangers.map((r) => r.id));
    for (const event of state.events) {
      if (event.actorId === null || !rangerIds.has(event.actorId)) continue;
      if (event.eventType === "SHOT_MISSED") {
        this.rangerConsecutiveMisses.set(
          event.actorId,
          (this.rangerConsecutiveMisses.get(event.actorId) ?? 0) + 1,
        );
      } else if (event.eventType === "SHOT_HIT") {
        this.rangerConsecutiveMisses.set(event.actorId, 0);
      }
    }
    this.phase.update({
      population: state.population,
      resources: state.resources,
      enemyNearCore: countEnemiesNearCore(state, this.config.threatEnemyDistance),
    });
    // 受击记忆推进（对齐竞品 recent_core_attack）：本 tick Core 受击则刷新记忆
    //   （即使无可见敌也保持 ENGAGED，防打完就跑后立刻放松）。
    this.recentAttackUntilTick = advanceRecentAttack(
      state.tick,
      state.core !== null && coreDamagedThisTick(state.events),
      this.recentAttackUntilTick,
    );
    // 威胁评估（threatBreakout 用）：decide 入口算一次（有 Core 时；受击记忆保持
    //   需要无可见敌也评估——recentAttackUntilTick 未过期返回 ENGAGED）。
    this.currentThreat = null;
    if (state.core !== null) {
      this.currentThreat = assessThreat({
        core: state.core.position,
        visibleEnemies: state.visibleEnemies,
        enemyHints: this.world.enemyHints(),
        coreDamagedThisTick: coreDamagedThisTick(state.events),
        squadContactThisTick: squadContactThisTick(
          state.events,
          new Set([...state.vanguards, ...state.rangers].map((u) => u.id)),
        ),
        obstacles: this.world.obstacles(state.obstacleCells),
        resourceCells: state.resourceCells,
        coreWatch: this.world.coreWatchTargets(this.config.coreThreatWatchTicks ?? CORE_THREAT_WATCH_TICKS),
        recentAttackUntilTick: this.recentAttackUntilTick,
        tick: state.tick,
      });
    }
    // 斩首配额 sortie 生命周期回收（W10，sortie-quota-v1）：decide 入口每 tick
    //   裁决一次 4 种取消理由（超时/目击过期/家防被袭击/目标消失），必须在
    //   威胁评估之后（取消理由 ③ 依赖 currentThreat）、消费侧（sortieTargetFor）
    //   之前。未启用时 Map 永空，pruneSorties 直接 return（零回归）。
    if (this.config.sortieQuota === true) {
      this.pruneSorties(state);
    }
    // W57 双相轮换治疗槽状态推进（guardHealRotationTwoPhase）：decide 入口每
    //   tick 调一次，在消费侧（Vanguard/Ranger heal-rotation 分支）之前推进
    //   FSM——patient 相伤员脱离危险血量/超时 → 转 relief；relief 冷却到期 →
    //   释放槽。未启用时 Map 永空，直接 return（零回归）。
    this.advanceHealRotationSlots(state);
    // MOVE_FAILED 反馈（moveFailedAvoidance / W37 conflictBackoff）：
    // 上 tick 结算拒绝的单位计连续失败，其余清零——连续失败 ≥2 时单位改走
    // 垂直绕行格探路（见 detourDirection），连续 ≥3 且绕行无路时 W37 短停
    // WAIT（见消费点 return_home / go_harvest）。
    if (this.config.moveFailedAvoidance === true || this.config.conflictBackoff === true) {
      const failed = new Set<string>();
      for (const event of state.events) {
        if (event.eventType === "UNIT_MOVE_FAILED" && event.actorId !== null) failed.add(event.actorId);
      }
      for (const unit of state.units) {
        if (failed.has(unit.id)) {
          this.moveFailedStreak.set(unit.id, (this.moveFailedStreak.get(unit.id) ?? 0) + 1);
        } else {
          this.moveFailedStreak.delete(unit.id);
        }
      }
    }
    // W38 饥饿门控事件消费（hungerGate）：HARVEST_Succeeded 更新该 worker 的
    // lastHarvestTick——patrolRing 截断时读取判定饥饿（tick - lastHarvest >
    // gateTicks = 饥饿放开远环，否则锁近环）。未启用时 Map 永空（零回归）。
    if (this.config.hungerGate === true) {
      for (const event of state.events) {
        if (event.eventType === "HARVEST_SUCCEEDED" && event.actorId !== null) {
          this.lastHarvestTick.set(event.actorId, state.tick);
        }
      }
    }
    // 记忆矿容量感知 + 卡死检测的 per-tick 状态（2026-08-08，t3 生产实证修复）。
    this.allocatedMines = new Map<string, number>();

    // C7 修复（2026-08-10）：军事单位卡死检测——位置连续 N tick 不变 =
    // capacity_wait / 路径被堵（不产生 UNIT_MOVE_FAILED → moveFailedStreak 盲区）。
    // 阈值后 spread 到相邻空格，打断无限 WAIT 循环。lastWorkerPos 存所有单位
    // 位置（上 tick 快照），此处先读后写（读 = 比较上 tick，写 = 存本 tick）。
    for (const unit of state.vanguards) {
      const prevPos = this.lastWorkerPos.get(unit.id);
      if (prevPos !== undefined && samePosition(prevPos, unit.position)) {
        this.militaryStuckStreak.set(unit.id, (this.militaryStuckStreak.get(unit.id) ?? 0) + 1);
      } else {
        this.militaryStuckStreak.delete(unit.id);
      }
    }
    for (const unit of state.rangers) {
      const prevPos = this.lastWorkerPos.get(unit.id);
      if (prevPos !== undefined && samePosition(prevPos, unit.position)) {
        this.militaryStuckStreak.set(unit.id, (this.militaryStuckStreak.get(unit.id) ?? 0) + 1);
      } else {
        this.militaryStuckStreak.delete(unit.id);
      }
    }

    for (const unit of state.units) this.lastWorkerPos.set(unit.id, unit.position);

    // Pattern 1（soft_obstacles_from_trail）：记录每个单位近期位置轨迹。
    // decideWorker 消费——检测到振荡（≤3 唯一位置 over last 6 tick）时
    // 把轨迹格变软障碍逼寻路离开循环区域。全单位记录（worker+vanguard+
    // ranger），消费方目前只 decideWorker；军事单位走 decideVanguard/
    // decideRanger，未来可扩展。
    for (const unit of state.units) {
      const trail = this.workerPositionTrail.get(unit.id) ?? [];
      trail.push(unit.position);
      if (trail.length > 6) trail.shift();
      this.workerPositionTrail.set(unit.id, trail);
    }

    // cargo-rescue-v1（W6，2026-08-09，cargo 被堵检测）：满载 worker 的 cargo
    // 连续 N tick 不变 = 被堵（无法卸货——入口满/Core 迁移中/路径被堵）。
    // 比较当前 cargo 与上 tick 记录：不变 → 推进 stuckSince；变化（卸货成功）
    // → 重置。只有 cargo > 0 的 worker 参与统计（空载 worker cargo=0 不算被堵）。
    // 死亡 worker 的残留条目由下方 alive 清理一并处理。
    if (this.config.cargoRescue === true) {
      const aliveCargoWorkers = new Set(state.workers.filter((w) => w.cargo > 0).map((w) => w.id));
      // 清理死亡/已卸货 worker 的 stuck 记录
      for (const unitId of this.cargoStuckSince.keys()) {
        if (!aliveCargoWorkers.has(unitId)) this.cargoStuckSince.delete(unitId);
      }
      // GAP 5.4 fix（2026-08-10，t1 生产实证 tick 83922）：Core MOVING 期间
      // 满载 worker 持货待命是设计行为（GAP 3.2 语义，迁移期不 DEPOSIT）——
      // cargo 不变≠被堵。旧版迁移期继续累积 stuck → cargoRescue 触发 → Core
      // 追远 worker → 更长时间 MOVING → 更多 stuck → **无限迁移循环**（t1
      // 实证：核心每 8 tick 迁移 1 格连续 30+ tick，经济冻结 res=100）。
      // 迁移期清空 stuck 记录（真实近核阻塞在 NORMAL 后 6 tick 内会重新累积）。
      if (state.core?.state === "MOVING") {
        this.cargoStuckSince.clear();
      }
      // 推进/重置 stuck 计数
      const previousCargo = this.cargoStuckCargoSnapshot;
      for (const worker of state.workers) {
        if (worker.cargo <= 0) continue;
        const prev = previousCargo.get(worker.id);
        // GAP 5.5 fix（2026-08-10，t1 生产实证 tick 83997）：cargo 不变 + **位置
        // 不变**才算被堵——返航中的 worker（cargo 天然不变、位置持续移动）不是
        // 被堵，只是回程中；旧版只看 cargo 会把"返航者"误判为被堵 → Core 追
        // 返航 worker 迁移（每 5-10 tick 1 格，永远追不到）→ 迁移期 worker 更
        // 无法卸货 → 恶性循环。位置持续移动（最近 2 tick 不同）的 worker 一律
        // 不算 stuck。workerPositionTrail 在 observe 开头对全部单位维护（≤6）。
        const trail = this.workerPositionTrail.get(worker.id) ?? [];
        const lastPos = trail[trail.length - 1];
        const prevPos = trail[trail.length - 2];
        const notMoving =
          lastPos !== undefined &&
          prevPos !== undefined &&
          lastPos[0] === prevPos[0] &&
          lastPos[1] === prevPos[1];
        if (prev !== undefined && worker.cargo === prev && notMoving) {
          // cargo 不变且位置不动 → 保持/推进 stuckSince（首次不变时初始化）
          if (!this.cargoStuckSince.has(worker.id)) {
            this.cargoStuckSince.set(worker.id, state.tick);
          }
        } else {
          // cargo 变化（卸货成功/新采）或位置移动（返航中）→ 重置
          this.cargoStuckSince.delete(worker.id);
        }
      }
      // 更新 cargo 快照供下 tick 比较
      this.cargoStuckCargoSnapshot = new Map(
        state.workers.filter((w) => w.cargo > 0).map((w) => [w.id, w.cargo]),
      );
    }

    // P1 战术小队（tactical-squads-v1，默认关）：每 tick 重算 squad 编成
    // （sticky 保持成员身份），供守家判定 / rally 集结位分散消费。关闭时
    // 恒空零回归。
    if (this.config.tacticalSquads === true) {
      const squadUnits: SquadUnit[] = [...state.vanguards, ...state.rangers].map((u) => ({
        id: u.id,
        unitType: u.unitType,
        position: u.position,
      }));
      this.tacticalSquadsValue = reconcileTacticalSquads(
        squadUnits,
        this.tacticalSquadPrevious,
        LOCAL_SQUAD_TENANT_ID,
        {
          homeAnchor: state.core?.position,
          homeVanguards: this.config.homeGuardVanguards ?? 2,
          homeRangers: this.config.homeGuardRangers ?? 1,
        },
      );
      this.tacticalSquadPrevious = this.tacticalSquadsValue.squadByUnit;
    } else if (this.tacticalSquadsValue !== EMPTY_SQUAD_MEMBERSHIP) {
      // 关闭兜底：与 updateConfig 同步清空（防御任何绕过 updateConfig 的
      // configValue 改写路径），保证 snapshot 与 sticky 不残留旧代。
      this.tacticalSquadsValue = EMPTY_SQUAD_MEMBERSHIP;
      this.tacticalSquadPrevious = new Map<string, string>();
    }

    const actions: Record<string, UnitAction> = {};
    const intents: Record<string, string> = {};
    const obstacles = this.world.obstacles(new Set([
      ...state.obstacleCells,
      ...(input.sharedObstacles ?? []),
    ]));
    const allies = input.allyUsernames ?? new Set<string>();
    const allyIds = this.rosterRef?.allyEntityIds ?? EMPTY_ROSTER_ID_SET;
    const enemies = state.visibleEnemies
      .filter((enemy) => !(enemy.kind === "CORE" && enemy.ownerUsername !== undefined && allies.has(enemy.ownerUsername)))
      .filter((enemy) => !allyIds.has(enemy.id))
      .sort((a, b) => a.id.localeCompare(b.id));
    this.alliedFilteredCount = state.visibleEnemies.length - enemies.length;
    const workerIndex = new Map(
      [...state.workers]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((worker, index) => [worker.id, index]),
    );
    const vanguardIndex = new Map(
      [...state.units]
        .filter((unit) => unit.unitType === "VANGUARD")
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((unit, index) => [unit.id, index]),
    );
    const rangerIndex = new Map(
      [...state.units]
        .filter((unit) => unit.unitType === "RANGER")
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((unit, index) => [unit.id, index]),
    );

    // 本 Tick 预计伤害账本（coordinated-fire-v1）：只用于友军目标去重，不改变
    // Arena action 语义。单位按 id 确定性决策，所以同一输入必得同一转火结果。
    const projectedFriendlyDamage = new Map<string, number>();
    const reserveDamage = (enemyId: string, amount = 1): void => {
      projectedFriendlyDamage.set(enemyId, (projectedFriendlyDamage.get(enemyId) ?? 0) + amount);
    };
    const set = (unit: UnitSnapshot, action: UnitAction, intent: string): void => {
      actions[unit.id] = action;
      intents[unit.id] = intent;
      if (this.config.coordinatedFire !== true) return;
      if (action.type === "SHOOT" && action.targetId !== null) {
        reserveDamage(action.targetId);
        return;
      }
      if (action.type === "SWEEP") {
        const targetCell = move(unit.position, action.direction);
        for (const enemy of enemies) {
          if (samePosition(enemy.position, targetCell)) reserveDamage(enemy.id);
        }
      }
    };

    // 锁阵配对（worker-blockade-v1，2026-08-08）：decide 入口算一次，多 worker
    // 共享同一分配（防扎堆/重复锁同一目标）。目标 = 敌方回程路径预测 + 环境
    // 瓶颈锁点；锁位手 = 巡逻态空 worker（blockadeWorkerCap 上限，保经济）。
    // 防御激活（召回/包围）→ 锁阵停用（锁位 worker 全员回守家圈）。
    // 预测断链保持（2026-08-08 修复）：敌方被锁原地后 prevPosition==position
    // → 差分消失 → enemyReturnPath 无预测 → 若清空配对锁手散伙、敌方原地
    // 重试成功突破（A/B 实证 t3 后敌方无 MOVE_FAILED 一路到核心）。断链时
    // 保留上一 tick 配对，锁手继续守原锁点（敌方原地重试同方向必再撞锁；
    // 锁龄超限由 decideWorker 的 lockMaxTicks 兜底释放）。
    const blockadeActive =
      this.config.workerBlockade === true &&
      state.workers.length >= (this.config.blockadeMinWorkers ?? BLOCKADE_MIN_WORKERS) &&
      !(this.currentThreat?.level === "BREAKOUT");
    if (!blockadeActive) {
      this.blockadeAssignment = new Map();
    }
    // 清理已死亡单位的短期状态残留：worker 死亡/重生 id 变化，旧 id 永不再命中。
    // 活性恢复冷却同时按 tick 到期删除，避免长期运行 Map 增长。
    // P2（2026-08-10）：moveFailedStreak / lastHarvestTick / conflictBackoffUntil
    // 一并纳入每 tick 存活剪枝。存活集合取 state.units（己方 worker+vanguard+
    // ranger；敌方在 visibleEnemies，不会误保）——moveFailedStreak 也被
    // Vanguard 攻坚消费（vanguard_pressure 绕行），不能只按 workers 剪。
    if (
      this.spawnYieldStreak.size > 0 ||
      this.workerLivenessRecoveryUntil.size > 0 ||
      this.moveFailedStreak.size > 0 ||
      this.lastHarvestTick.size > 0 ||
      this.conflictBackoffUntil.size > 0
    ) {
      const alive = new Set(state.workers.map((worker) => worker.id));
      const aliveUnits = new Set(state.units.map((unit) => unit.id));
      for (const unitId of this.spawnYieldStreak.keys()) {
        if (!alive.has(unitId)) this.spawnYieldStreak.delete(unitId);
      }
    if (!blockadeActive) {
      this.blockadeAssignment = new Map();
      this.coreLockHands = new Set();
    }
    // 清理已死亡单位的短期状态残留：worker 死亡/重生 id 变化，旧 id 永不再命中。
    // 活性恢复冷却同时按 tick 到期删除，避免长期运行 Map 增长。
    // P2（2026-08-10）：moveFailedStreak / lastHarvestTick / conflictBackoffUntil
    // 一并纳入每 tick 存活剪枝。存活集合取 state.units（己方 worker+vanguard+
    // ranger；敌方在 visibleEnemies，不会误保）——moveFailedStreak 也被
    // Vanguard 攻坚消费（vanguard_pressure 绕行），不能只按 workers 剪。
    if (
      this.spawnYieldStreak.size > 0 ||
      this.workerLivenessRecoveryUntil.size > 0 ||
      this.moveFailedStreak.size > 0 ||
      this.lastHarvestTick.size > 0 ||
      this.conflictBackoffUntil.size > 0
    ) {
      const alive = new Set(state.workers.map((worker) => worker.id));
      const aliveUnits = new Set(state.units.map((unit) => unit.id));
      for (const unitId of this.spawnYieldStreak.keys()) {
        if (!alive.has(unitId)) this.spawnYieldStreak.delete(unitId);
      }
      for (const [unitId, untilTick] of this.workerLivenessRecoveryUntil) {
        if (!alive.has(unitId) || untilTick <= state.tick) this.workerLivenessRecoveryUntil.delete(unitId);
      }
      for (const unitId of this.moveFailedStreak.keys()) {
        if (!aliveUnits.has(unitId)) this.moveFailedStreak.delete(unitId);
      }
      for (const unitId of this.lastHarvestTick.keys()) {
        if (!aliveUnits.has(unitId)) this.lastHarvestTick.delete(unitId);
      }
      for (const unitId of this.conflictBackoffUntil.keys()) {
        if (!aliveUnits.has(unitId)) this.conflictBackoffUntil.delete(unitId);
      }
      for (const unitId of this.workerPositionTrail.keys()) {
        if (!aliveUnits.has(unitId)) this.workerPositionTrail.delete(unitId);
      }
    }
    }
    if (blockadeActive) {
      const hints = this.world.enemyHints();
      const coreTargets = this.world.coreHuntTargets();
      const predictions = enemyReturnPath(hints, coreTargets, obstacles)
        // 过滤：锁点落在己方核心格 = 禁区（worker 站核心格会挡 DEPOSIT/SPAWN，
        // t2 卸货死锁教训）——朝核心移动的敌方预测可能直接指向核心格。
        .filter((prediction) =>
          state.core === null || !samePosition(prediction.nextCells[0], state.core.position),
        );
      // 环境锁点（敌核心邻格优先）——没有回程预测时仍可锁环境瓶颈
      const idleWorkers = state.workers.filter((worker) => worker.cargo === 0);
      const assignment = pairBlockadeTargets(predictions, idleWorkers, this.config.blockadeWorkerCap ?? BLOCKADE_WORKER_CAP);
      // 环境锁点兜底：无回程预测但敌核心已知（CORE 目击）→ 派最近 worker
      // 锁敌核心邻格（断敌方卸货通道）。仅 CORE 源——WORKER_INFER 锚点
      // 可能锁错位置（推测核心），且无回程预测时锁空位白站（t1 即触发
      // 资源旁锁点、锁手被派去空位的 A/B 实证）。
      if (
        assignment.size === 0 &&
        idleWorkers.length > 0 &&
        coreTargets.some((t) => t.source === "CORE")
      ) {
        const enemyCore = coreTargets.find((t) => t.source === "CORE")?.position ?? null;
        const occupied = new Set(
          [...state.units].map((unit) => cellKey(unit.position)),
        );
        const chokepoint = chokepointLockPoint(enemyCore, [...state.resourceCells].map(parseCell), obstacles, occupied);
        if (chokepoint !== null && manhattan(chokepoint.cell, state.core?.position ?? chokepoint.cell) <= BLOCKADE_ENV_MAX_DIST) {
          const nearest = [...idleWorkers]
            .sort((a, b) => manhattan(a.position, chokepoint.cell) - manhattan(b.position, chokepoint.cell) || a.id.localeCompare(b.id))[0];
          if (nearest !== undefined) assignment.set(nearest.id, chokepoint.cell);
        }
      }
      // 新配对覆盖旧配对；预测断链（assignment 空）→ 保留上一 tick 配对，
      // 锁手继续守原锁点（敌方原地重试必再撞；锁龄超限兜底释放）。
      if (assignment.size > 0) {
        this.blockadeAssignment = assignment;
        // 标记终点封锁锁手（锁点 = 敌核心入口邻格）：锁龄放宽到
        // BLOCKADE_CORE_LOCK_MAX_TICKS（锁手提前部署，敌方回程可能还有
        // 十几格；10 tick 普通锁龄会先满导致提前放弃）。
        this.coreLockHands = new Set();
        for (const [unitId, lockPoint] of assignment) {
          if (
            coreTargets.some(
              (target) => target.source === "CORE" && manhattan(target.position, lockPoint) === 1,
            )
          ) {
            this.coreLockHands.add(unitId);
          }
        }
      }
    }

    // VANGUARD 预判拦截配对（vanguard-blockade-v1，2026-08-08，手操实证）：
    // 只锁敌方 WORKER（军事单位由战斗逻辑处理）；拦截点复用 pairBlockadeTargets
    // 的 margin/终点封锁逻辑；与 prey 互斥——prey 已覆盖（12 格内）的目标跳过。
    // 防御激活（BREAKOUT）→ 停用（拦截手回守）。
    const vanguardBlockadeActive =
      this.config.vanguardBlockade === true &&
      !(this.currentThreat?.level === "BREAKOUT");
    if (!vanguardBlockadeActive) {
      this.vanguardBlockadeAssignment = new Map();
    }
    if (vanguardBlockadeActive) {
      const hints = this.world.enemyHints();
      const coreTargets = this.world.coreHuntTargets();
      const predictions = enemyReturnPath(hints, coreTargets, obstacles)
        .filter((prediction) => prediction.enemyType === "WORKER")
        // targetCore 只保留真实 CORE 目击（终点封锁可靠）；WORKER_INFER
        // 推断锚点随敌方移动漂移（前方 8 格），单 Vanguard 跑 20+ 格去错误
        // 入口 = 白费（A/B 实证 Vanguard 移动 60 格零击杀）——降级为中途
        // 拦截（margin 选点），由伏击兜底承接采集点蹲守。
        .map((prediction) =>
          prediction.targetCore !== null &&
          coreTargets.some(
            (target) => target.source === "CORE" && samePosition(target.position, prediction.targetCore!),
          )
            ? prediction
            : { ...prediction, targetCore: null },
        )
        // 禁区：锁点落在己方核心格不锁（军事禁区 + 挡卸货通道）。
        .filter((prediction) =>
          state.core === null || !samePosition(prediction.nextCells[0], state.core.position),
        );
      // prey 已覆盖的目标（12 格内最近猎手-猎物配对）跳过——不重复抢活。
      let preyTarget: Position | null = null;
      if (this.config.vanguardPreyWorker === true && state.core !== null) {
        let prey: VisibleEntity | undefined;
        let preyDist = Number.POSITIVE_INFINITY;
        for (const enemy of state.visibleEnemies) {
          if (enemy.kind !== "UNIT" || enemy.unitType !== "WORKER") continue;
          for (const v of state.vanguards) {
            const d = manhattan(v.position, enemy.position);
            if (d < preyDist) { preyDist = d; prey = enemy; }
          }
        }
        if (prey !== undefined && preyDist <= PREY_WORKER_RADIUS) {
          preyTarget = prey.position;
        }
      }
      const filtered = predictions.filter(
        (prediction) => preyTarget === null || !samePosition(prediction.position, preyTarget),
      );
      const idleVanguards = state.vanguards;
      const assignment = pairBlockadeTargets(
        filtered,
        idleVanguards,
        this.config.vanguardBlockadeCap ?? VANGUARD_BLOCKADE_CAP,
      );
      // 伏击兜底（2026-08-08）：无移动预测命中时，可见敌方 WORKER 正在采集
      // 的资源点（敌方 worker 位置 ∈ resourceCells）→ 派最近 Vanguard 去该
      // 资源点邻格蹲守——敌方回程/再采必经此格，Vanguard 有攻击力守株待兔
      // （手操实证：敌方 worker 在资源点附近徘徊被卡 + 挨打）。与 prey 追击
      // 的区别：追击追着跑（同速追不上），蹲守等敌方自投罗网。
      if (assignment.size === 0 && idleVanguards.length > 0) {
        for (const enemy of state.visibleEnemies) {
          if (enemy.kind !== "UNIT" || enemy.unitType !== "WORKER") continue;
          if (!state.resourceCells.has(cellKey(enemy.position))) continue;
          // 资源格四邻第一个空位（避障碍/占用）——蹲守点
          const ambush = (["UP", "RIGHT", "DOWN", "LEFT"] as const)
            .map((d) => move(enemy.position, d))
            .find((cell) => !obstacles.has(cellKey(cell)));
          if (ambush === undefined) break;
          const nearest = [...idleVanguards]
            .sort((a, b) => manhattan(a.position, ambush) - manhattan(b.position, ambush) || a.id.localeCompare(b.id))[0];
          if (nearest !== undefined) assignment.set(nearest.id, ambush);
          break;
        }
      }
      if (assignment.size > 0) {
        this.vanguardBlockadeAssignment = assignment;
      }
    }

    for (const unit of [...state.units].sort((a, b) => a.id.localeCompare(b.id))) {
      if (
        state.beacon.status === "GROUND" &&
        state.beacon.carrierId === null &&
        samePosition(unit.position, state.beacon.position)
      ) {
        set(unit, { type: "PICKUP_BEACON" }, "beacon");
        continue;
      }
      if (
        state.core !== null &&
        state.core.state === "NORMAL" &&
        samePosition(unit.position, state.core.position) &&
        unit.hp < UNIT_MAX_HP[unit.unitType]
      ) {
        set(unit, { type: "HEAL" }, "heal");
        continue;
      }

      if (unit.unitType === "WORKER") {
        this.decideWorker(state, unit, workerIndex.get(unit.id) ?? 0, obstacles, set);
      } else if (unit.unitType === "VANGUARD") {
        this.decideVanguard(state, unit, vanguardIndex.get(unit.id) ?? 0, obstacles, enemies, set);
      } else {
        this.decideRanger(
          state, unit, rangerIndex.get(unit.id) ?? 0, obstacles, enemies, projectedFriendlyDamage, set,
        );
      }
    }

    const coreAction = this.decideCore(state, intents);
    return { tick: state.tick, unitActions: actions, coreAction, intents };
  }

  /** 流水线预取（P4g，决策流水线）：同步计算并缓存——决策输入与串行 decide
   *  相同，结果逐字节一致；仅时间点前移（结算后即算，不阻塞调用方）。 */
  prefetch(input: SafetyPlannerInput): void {
    this.prefetchedPlanValue = this.decide(input);
  }

  /** 取流水线预取结果（P4g）：必须在 prefetch 之后成对调用。 */
  decideCached(): Plan {
    const plan = this.prefetchedPlanValue;
    this.prefetchedPlanValue = null;
    if (plan === null) {
      throw new Error("safety planner: decideCached without prefetch");
    }
    return plan;
  }

  /** worker 巡逻目标点（worker-dense-scan-v1，2026-08-07）：密集模式用 16 方位
   *  （exploreTargetDense，相邻方位间距减半——8 方位在半径 24 处相邻 ~18 格 >
   *  视野 3×2 盲区大）；默认 8 方位 exploreTarget（零回归）。 */
  private workerPatrolPoint(
    home: Position,
    beacon: Position,
    direction: number,
    radius: number,
  ): Position {
    return this.config.workerDenseScan === true
      ? exploreTargetDense(home, beacon, direction, radius)
      : exploreTarget(home, beacon, direction, radius);
  }

  /** worker 巡逻方位（threat-sector-scout-v1）：变体开启且有威胁方向时向威胁
   *  扇区加权（threatWeightedDirection），否则历史均匀方位（零回归）。 */
  private workerPatrolDirection(index: number, home: Position | null): number {
    // worker 密集扫图（worker-dense-scan-v1）：16 方位直接分散（workerDenseDirection，
    // 与 8 方位 +3 步进同构的分散方案）——威胁扇区加权是 8 方位口径，密集模式
    // 暂不叠加（覆盖分散优先）。默认走威胁加权/均匀 8 方位（零回归）。
    if (this.config.workerDenseScan === true) return workerDenseDirection(index);
    const sector =
      this.config.threatSectorScout === true && home !== null
        ? this.world.threatSectorFrom(home)
        : null;
    return threatWeightedDirection(index, sector);
  }

  private decideWorker(
    state: TickState,
    unit: UnitSnapshot,
    index: number,
    obstacles: ReadonlySet<string>,
    set: (unit: UnitSnapshot, action: UnitAction, intent: string) => void,
  ): void {
    const home = state.core?.position ?? null;
    const memory = this.world.unitMemory(unit.id, this.workerPatrolDirection(index, home));
    // Pattern 1（soft_obstacles_from_trail，竞品 waaiging arena-hero-tactic
    // pathing.py:383-406）：worker 近期轨迹格变软障碍——检测到振荡（≤3
    // 唯一位置 over last 6 tick）时把轨迹中非当前格加入障碍集，逼寻路
    // 离开循环区域。当前格永不被封。全封时回退（不困死 worker）。防
    // 恢复后 re-oscillation（t1 实证：worker [-562,-111]/[-563,-111] 横跳
    // 25+ tick，egressExit 评分已防大部分，此为兜底）。
    let movementObstacles = this.world.movementObstacles(unit.id, obstacles);
    const trail = this.workerPositionTrail.get(unit.id) ?? [];
    if (trail.length >= 4) {
      const recentTrail = trail.slice(-6);
      const uniquePositions = new Set(recentTrail.map((pos) => cellKey(pos)));
      if (uniquePositions.size <= 3) {
        const softObstacles = new Set(movementObstacles);
        for (const pos of recentTrail) {
          if (!samePosition(pos, unit.position)) {
            softObstacles.add(cellKey(pos));
          }
        }
        // 仅当 worker 仍有至少一个可走邻居时才应用（防全封困死）
        let hasValidNeighbor = false;
        for (const [deltaX, deltaY] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
          const neighborKey = cellKey([unit.position[0] + deltaX, unit.position[1] + deltaY]);
          if (!softObstacles.has(neighborKey)) {
            hasValidNeighbor = true;
            break;
          }
        }
        if (hasValidNeighbor) movementObstacles = softObstacles;
      }
    }
    const maxPatrolRadius = this.resourceAssignmentMaxDistanceFromCore(state);

    if (unit.cargo > 0) {
      // near_core_deposit RETREAT 锁（2026-08-10，t1 生产吞吐修复，竞品
      // arena_hero_strategy.py roles.py:158-181 对照）：满载 worker 距 Core
      // ≤4（Manhattan）时禁止因邻接敌改 RETREAT——保持 DEPOSIT/return_home
      // 朝 Core 步进。线下：worker 贴近 Core（≤4）却被敌工挡在入口 man≈2
      // 处排队 hold / 垂直绕行漂离，workersWithCargo 累积、均值逼近 exile。
      // 锁激活时：敌占入口不 hold（仍朝 Core 走，绕开敌工；友军占满照常
      // hold 不争抢）+ 跳过 moveFailedAvoidance 垂直绕行（不漂离 Core，保持
      // stepToward）+ return_home BFS 把可见敌占格并入障碍——绕开敌工朝 Core
      // 推进（竞品 RETREAT hint=core_position 语义），敌封死所有路时回退 plain
      // stepToward（贴脸仍朝 Core 走，dist>0 不改 RETREAT）。零回归：仅影响
      // "满载 worker 距 Core ≤4 + 邻接敌"窄场景；缺省 true，false 完全关闭
      // （变体各按自身门控）。
      const nearCoreDepositLocked =
        this.config.nearCoreDepositLockEnabled !== false &&
        home !== null &&
        manhattan(unit.position, home) <= NEAR_CORE_DEPOSIT_RADIUS;
      // cargo-rescue-v1（W6，2026-08-09，清旧目标）：满载 worker 不清理旧采集目标
      // → 追空矿冻结（reference `clear_worker_goal` :1563 + 目标优先级第一层"当前
      // 可见未预留资源"）。满载 worker 下一 tick 本该 return_home 卸货，但
      // memory.harvestTarget 仍指向已采空/不可见的旧矿——卸完货立刻又 go_harvest_mem
      // 追空矿、HARVEST 失败 → 无限循环。变体开启时：满载 worker 的采集目标
      // 不在当前可见资源里 → 清除（不追空矿冻结）。当前可见矿仍保留（worker
      // 卸完货可立刻折返继续采）。零回归：变体关闭时不执行（历史行为保留旧目标）。
      if (this.config.cargoRescue === true && memory.harvestTarget !== null) {
        const visibleResources = [...state.resourceCells];
        const targetKey = cellKey(memory.harvestTarget);
        if (!visibleResources.includes(targetKey)) {
          memory.harvestTarget = null;
          memory.workerMode = "patrol";
        }
      }
      // 产兵让位（spawn-yield-v1，2026-08-08）：核心本 tick 计划 SPAWN 时，
      // 满载 worker 在核心格/核心邻格 → 让位——DEPOSIT Phase8 先于 SPAWN
      // Phase10，worker 卸货成功仍占核心格会挡掉同 tick SPAWN（生产 t2 实证
      // 112 次 CORE_SPAWN_FAILED/CELL_UNIT_LIMIT，其中 74 次是 worker 本 tick
      // 移入核心格、38 次已在核心格；现核心区 9 次仍在发生）。产兵价值 >
      // 1 资源卸货，让位净赚。已在核心格 → 让出（复用 coreClearance 出口）；
      // 在邻格 → WAIT 不进核心格（下 tick 核心 spawn 完成后正常卸货）。
      if (this.config.spawnYield === true && home !== null && this.coreWantsSpawn(state)) {
        const yieldMaxTicks = this.config.spawnYieldMaxTicks ?? SPAWN_YIELD_MAX_TICKS;
        const streak = this.spawnYieldStreak.get(unit.id) ?? 0;
        if (streak < yieldMaxTicks && samePosition(unit.position, home)) {
          const exit = this.egressExit(home, movementObstacles, occupancyCounts(state), state.visibleEnemies, index);
          if (exit !== null && !samePosition(unit.position, exit)) {
            const direction = stepToward(unit.position, exit, movementObstacles);
            if (direction !== null) {
              this.spawnYieldStreak.set(unit.id, streak + 1);
              set(unit, { type: "MOVE", direction }, "worker_yield_spawn");
              return;
            }
          }
        } else if (
          streak < yieldMaxTicks &&
          manhattan(unit.position, home) === 1
        ) {
          // 邻格待命：不移动进核心格，下 tick 核心 spawn 完成后再进卸货。
          this.spawnYieldStreak.set(unit.id, streak + 1);
          set(unit, { type: "WAIT" }, "worker_yield_spawn");
          return;
        }
        // 让位超限（连续让位 ≥max tick 仍未卸）→ 强制卸货，防让位饿死循环。
        this.spawnYieldStreak.delete(unit.id);
      }
      // 迁移激活期持货待命（migration-hold-v1，2026-08-09）：计划 LEG_MOVE
      // 期间满载 worker 不挤核心——核心 4 邻是移动通道，满载 worker 追核心
      // 格卸货会把路径格占满（容量 2）→ CORE_MOVE_START_FAILED → 核心
      // NORMAL 停滞横跳（t1 生产实证：核心 [-562,-111]/[-563,-111] 横跳
      // 25+ tick，15 tick 内 CORE_MOVE_START_FAILED 2 次、DEPOSIT 只成功 1
      // 次、89 次 REPLAN）。coreMovingHold 只看引擎 MOVING 态——核心被堵
      // 停 NORMAL 时不触发，此处用计划态兜底。等待位 = 核心外环避路径格
      // （guardHomeCell with avoid）；休整期（LEG_SETTLE，migrationMoving
      // =false）恢复正常回仓卸货（burst 32 tick 移动 + 30-90 tick 休整，
      // 足够卸完）。
      if (this.migrationMoving && state.core !== null) {
        const waitPost = guardHomeCell(
          state.core.position,
          movementObstacles,
          index,
          this.migrationPathAhead(state.core.position),
        );
        if (waitPost !== null && !samePosition(unit.position, waitPost)) {
          const direction = stepToward(unit.position, waitPost, movementObstacles);
          if (direction !== null) {
            set(unit, { type: "MOVE", direction }, "worker_hold_cargo_migrate");
            return;
          }
        }
        set(unit, { type: "WAIT" }, "worker_hold_cargo_migrate");
        return;
      }
      // 核心迁移中交仓待命（core-moving-hold-v1，2026-08-07）：MOVING 期间
      // 引擎拒绝 DEPOSIT（CORE_MOVING/CORE_NOT_PRESENT——生产实测 t2/t3 手操
      // 迁移时 150 tick 内 17/11 次失败），cargo worker 原地持货等核心稳定，
      // 不追着移动核心空跑；核心回 NORMAL 后恢复正常交仓。
      if (
        this.config.coreMovingHold === true &&
        state.core?.state === "MOVING"
      ) {
        // 满载 worker 站在核心格上（核心 MOVING 中）→ 先移出核心格待命（不堵迁移路径/
        // 不站桩核心格，2026-08-08 生产实证 t1 worker 在 MOVING 核心格上站桩）；
        // 不在核心格 → 原地持货等核心稳定（核心回 NORMAL 后恢复交仓）。
        if (home !== null && samePosition(unit.position, home)) {
          const exit = this.egressExit(home, movementObstacles, occupancyCounts(state), state.visibleEnemies, index);
          if (exit !== null && !samePosition(unit.position, exit)) {
            const direction = stepToward(unit.position, exit, movementObstacles);
            if (direction !== null) { set(unit, { type: "MOVE", direction }, "worker_hold_cargo_off_core"); return; }
          }
        }
        set(unit, { type: "WAIT" }, "worker_hold_cargo_moving");
        return;
      }
      if (home !== null && samePosition(unit.position, home)) {
        // 核心迁移中（引擎 MOVING）DEPOSIT 必失败（CORE_MOVING，规则：迁移中
        // Core 不接收卸货——t1 生产实测 24 次）。无条件拦截（不依赖
        // coreMovingHold 开关——历史行为是每 tick 白跑失败一次）；满载 worker
        // 移出核心格待命，不堵迁移路径/生产通道。
        const coreMoving = state.core?.state === "MOVING";
        if (coreMoving) {
          const exit = this.egressExit(home, movementObstacles, occupancyCounts(state), state.visibleEnemies, index);
          if (exit !== null && !samePosition(unit.position, exit)) {
            const direction = stepToward(unit.position, exit, movementObstacles);
            if (direction !== null) { set(unit, { type: "MOVE", direction }, "worker_hold_cargo_off_core"); return; }
          }
          set(unit, { type: "WAIT" }, "worker_hold_cargo_moving");
          return;
        }
        if (state.resourceSpace > 0) set(unit, { type: "DEPOSIT" }, "deposit");
        else if (this.config.coreClearance === true) {
          // 核心满卸不了 → 离开核心格待命，不堵通道（guide 竞品
          // "Core 满仓分散待命并腾空生产格" 对齐——满载 worker 占核心格会
          // 挡 SPAWN/后续卸货）。
          const exit = this.egressExit(home, movementObstacles, occupancyCounts(state), state.visibleEnemies, index);
          if (exit !== null && !samePosition(unit.position, exit)) {
            const direction = stepToward(unit.position, exit, movementObstacles);
            if (direction !== null) { set(unit, { type: "MOVE", direction }, "worker_clear_core"); return; }
          }
        }
      } else if (home !== null) {
        // cargo-rescue-v1（W6，2026-08-09，排队 hold）：满载 worker 距 Core ≤2
        // 且核心格/邻格入口已满（容量 2 含 Core）→ worker_hold_cargo_queue（原地
        // WAIT 不争抢，与 worker_hold_cargo_moving 区分——后者是 Core MOVING 中
        // 持货待命，前者是 Core NORMAL 但入口拥堵排队）。reference `cargo_queue_hold`
        // :3707-3710：距 Core ≤2 入口满时原地 hold，不与其他满载 worker 争抢核心格
        // （争抢 = MOVE_CONTESTED 互堵 → 全卡死 → 0 卸货 → 经济冻结）。入口判定：
        // stepToward 的下一格（朝 Core 方向）占用 ≥ CARGO_QUEUE_ENTRY_LIMIT（2）
        // → 入口满，原地 WAIT。零回归：变体关闭时不执行（历史行为照常争抢）。
        if (
          this.config.cargoRescue === true &&
          manhattan(unit.position, home) <= CARGO_QUEUE_HOLD_RADIUS
        ) {
          const entryDirection = stepToward(unit.position, home, movementObstacles);
          if (entryDirection !== null) {
            const entryCell = move(unit.position, entryDirection);
            const occupancy = occupancyCounts(state);
            // 敌占格视为满（不争抢敌占入口——争抢 = 送死）
            const enemyBlocking = state.visibleEnemies.some(
              (enemy) => samePosition(enemy.position, entryCell),
            );
            const entryCount = occupancy.get(cellKey(entryCell)) ?? 0;
            // near_core_deposit 锁：满载 worker 距 Core ≤4 + 敌占入口时不 hold
            // （仍朝 Core 走——下方 return_home BFS 把敌占格并入障碍绕开敌工，
            // 不改 RETREAT 远离 Core）。锁关或入口被友军占满（容量满，争抢必
            // MOVE_CONTESTED 互堵）时照常 hold（零回归）。
            const holdForEnemy = enemyBlocking && !nearCoreDepositLocked;
            if (holdForEnemy || entryCount >= CARGO_QUEUE_ENTRY_LIMIT) {
              set(unit, { type: "WAIT" }, "worker_hold_cargo_queue");
              return;
            }
          }
        }
        const stuckTicks = this.moveFailedStreak.get(unit.id) ?? 0;
        // W37 冲突退避时间窗（conflictBackoff）：冷却内原地 WAIT——打破两单位
        // 互挡且绕行格互占的互等锁死（空间绕行失败 → 时间等待让敌方先移）。
        if (this.config.conflictBackoff === true) {
          const backoffUntil = this.conflictBackoffUntil.get(unit.id);
          if (backoffUntil !== undefined) {
            if (backoffUntil > state.tick) {
              set(unit, { type: "WAIT" }, "conflict_backoff");
              return;
            }
            this.conflictBackoffUntil.delete(unit.id);
          }
        }
        // near_core_deposit 锁激活时：满载 worker 距 Core ≤4 把可见敌占格并入
        // BFS 障碍——绕开敌工朝 Core 推进（竞品 RETREAT hint=core_position 语义，
        // 不改 RETREAT 远离 Core），敌封死所有路时回退 plain stepToward（贴脸但
        // 未上 Core dist>0 仍朝 Core 走）；同时跳过 moveFailedAvoidance 垂直绕行
        // （不漂离 Core）。锁关闭时走历史行为（detour/stepToward 二选一，
        // movementObstacles 不含敌占格，零回归）。
        let direction: Direction | null;
        if (nearCoreDepositLocked) {
          const enemyAwareObstacles = new Set(movementObstacles);
          for (const enemy of state.visibleEnemies) {
            if (enemy.kind === "UNIT") enemyAwareObstacles.add(cellKey(enemy.position));
          }
          direction = stepToward(unit.position, home, enemyAwareObstacles)
            ?? stepToward(unit.position, home, movementObstacles);
        } else {
          direction =
            this.config.moveFailedAvoidance === true && stuckTicks >= 2
              ? detourDirection(unit.position, home, movementObstacles)
              : stepToward(unit.position, home, movementObstacles);
        }
        if (direction !== null) {
          set(unit, { type: "MOVE", direction }, "return_home");
        } else if (
          this.config.conflictBackoff === true &&
          stuckTicks >= (this.config.conflictBackoffThreshold ?? CONFLICT_BACKOFF_THRESHOLD)
        ) {
          // detour/stepToward 均无路且连续失败 ≥ 阈值 → 短停 WAIT（对齐 ref
          // _move_backoff = tick+2；MOVED 即清零已由 moveFailedStreak 维护）。
          this.conflictBackoffUntil.set(
            unit.id,
            state.tick + (this.config.conflictBackoffTicks ?? CONFLICT_BACKOFF_TICKS),
          );
          set(unit, { type: "WAIT" }, "conflict_backoff");
        }
      }
      return;
    }

    // 核心通道清障（core-clearance-v1 扩展，2026-08-08，v3 eddb4f5 移植）：
    // 空载 worker 占核心格且不在此刻回血（主循环 HEAL 已处理）→ 疏散到最近
    // 空邻格/外圈，让位给满载 worker 卸货。生产 t2 实证：同一空 worker 占
    // 核心格 130+ tick（无资源任务 WAIT），4 满载 worker + 4 Vanguard 围死
    // 卸货通道，deposit=0 经济冻结——原有 coreClearance 只疏散军事/满载占
    // 核心格，漏了空载 idle worker。疏散目标优先「物理空邻格」（occ=0，无
    // MOVE_CONTESTED 冲突），无空位再退单占用邻格（容量 2 可挤入）、最后
    // 外圈守位点。快照里的 worker 均非本 tick 刚产（出生 tick 不可行动由
    // 服务器裁决），疏散合法。
    if (
      this.config.coreClearance === true &&
      home !== null &&
      samePosition(unit.position, home) &&
      !(unit.hp < UNIT_MAX_HP[unit.unitType])
    ) {
      // 疏散目标优先「物理空邻格」：用真实障碍 + 实时占用判定，忽略 move-failed
      // 瞬时标记（标记可能来自别的单位/旧条件——生产 t2 实证：核心 4 邻中
      // RIGHT/DOWN 物理空（occ=0）却被瞬时标记成障碍，yieldAnchor 返回 null，
      // fallback 选被占 LEFT → MOVE_CONTESTED → 空 worker 永远走不出核心格）。
      // 无物理空位再退单占用邻格（容量 2 可挤入）、再退外圈守位点。
      const occupancy = occupancyCounts(state);
      // 敌占格视为不可疏散目标（2026-08-08 审查修复）：occ 扫描只看我方单位，
      // 敌格显示 occ=0 → 空 worker 可能朝敌疏散送死。把可见敌占格提升为
      // occ=2（满），两遍扫描与 yieldAnchor 都不会选它。
      for (const enemy of state.visibleEnemies) {
        occupancy.set(cellKey(enemy.position), 2);
      }
      let exit: Position | null = null;
      const cardinals: readonly Position[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (const direction of cardinals) {
        const cand: Position = [home[0] + direction[0], home[1] + direction[1]];
        if (state.obstacleCells.has(cellKey(cand))) continue;
        if ((occupancy.get(cellKey(cand)) ?? 0) === 0) {
          exit = cand;
          break;
        }
      }
      if (exit === null) {
        for (const direction of cardinals) {
          const cand: Position = [home[0] + direction[0], home[1] + direction[1]];
          if (state.obstacleCells.has(cellKey(cand))) continue;
          if ((occupancy.get(cellKey(cand)) ?? 0) < 2) {
            exit = cand;
            break;
          }
        }
      }
      exit ??= yieldAnchor(home, movementObstacles, occupancy, state.visibleEnemies);
      exit ??= this.coreGuardFallback(home, movementObstacles, index);
      if (exit !== null && !samePosition(unit.position, exit)) {
        const direction = stepToward(unit.position, exit, state.obstacleCells);
        if (direction !== null) { set(unit, { type: "MOVE", direction }, "worker_clear_core_empty"); return; }
      }
    }

    // B10 worker 遭遇撤离（scoutEvade 候选，竞品 Scout And Observer
    // Response 对照）：空 worker 视野内（3 格）出现战斗单位 → 撤离回
    // Core（EVADE+RETURN 合一——向 Core 步进即远离敌人，敌占格视为
    // 硬块绕开）——接触丢失后仍持续回 Core（persistent return flow，
    // 不恢复旧巡逻线），到 Core 3 格内冷却 3 tick 再恢复（防敌人尾随
    // 立即再逃）；冷却到期清除状态。
    if (this.config.scoutEvade === true && home !== null) {
      const threatened = state.visibleEnemies.some(
        (enemy) =>
          enemy.kind === "UNIT" &&
          enemy.unitType !== "WORKER" &&
          manhattan(unit.position, enemy.position) <= SCOUT_EVADE_RADIUS,
      );
      if (threatened) {
        this.scoutEvadeState.set(unit.id, {
          returnUntil: Number.POSITIVE_INFINITY,
          cooldownUntil: 0,
        });
      }
      const evade = this.scoutEvadeState.get(unit.id);
      if (evade !== undefined) {
        // 冷却到期 → 清除状态，恢复正常巡逻/采集
        if (evade.cooldownUntil > 0 && evade.cooldownUntil <= state.tick) {
          this.scoutEvadeState.delete(unit.id);
        } else if (evade.cooldownUntil > state.tick) {
          set(unit, { type: "WAIT" }, "worker_evade_cooldown");
          return;
        } else if (manhattan(unit.position, home) <= SCOUT_HOME_RADIUS) {
          // 撤离流中到达 Core 3 格内 → 进入冷却（防尾随立即再逃）
          this.scoutEvadeState.set(unit.id, {
            returnUntil: Number.POSITIVE_INFINITY,
            cooldownUntil: state.tick + SCOUT_COOLDOWN_TICKS,
          });
          set(unit, { type: "WAIT" }, "worker_evade_cooldown");
          return;
        } else {
          // 敌占格视为硬块（竞品 enemy-occupied cells remain hard blocks）
          const evadeObstacles = new Set(movementObstacles);
          for (const enemy of state.visibleEnemies) {
            if (enemy.kind === "UNIT" && enemy.unitType !== "WORKER") {
              evadeObstacles.add(cellKey(enemy.position));
            }
          }
          const direction = stepToward(unit.position, home, evadeObstacles);
          if (direction !== null) set(unit, { type: "MOVE", direction }, "worker_evade_return");
          return;
        }
      }
    }

    // 锁阵执行（worker-blockade-v1，2026-08-08）：本 tick 配对到锁点的巡逻
    // worker → 走向锁点站桩（敌方目标格被占 → MOVE_DESTINATION_OCCUPIED
    // 敌方失败；脚本对手无反馈无限重试）。锁龄超限（预测错误/敌方已绕路）
    // → 放弃回巡逻；敌方战斗单位近身 ≤3 格 → 立即撤离（复用 scoutEvade
    // 半径，锁位 worker 无攻击力保命优先）。
    if (this.config.workerBlockade === true) {
      const lockPoint = this.blockadeAssignment.get(unit.id);
      if (lockPoint !== undefined) {
        // 终点封锁（锁点 = 敌核心入口邻格）→ 放宽锁龄：锁手提前部署，
        // 敌方回程可能还有十几格；10 tick 普通锁龄会先满而敌方未到。
        const lockMaxTicks = this.coreLockHands.has(unit.id)
          ? BLOCKADE_CORE_LOCK_MAX_TICKS
          : this.config.blockadeLockMaxTicks ?? BLOCKADE_LOCK_MAX_TICKS;
        const lockedSince = this.blockadeLockedSince.get(unit.id);
        const enemyNear = state.visibleEnemies.some(
          (enemy) =>
            enemy.kind === "UNIT" &&
            enemy.unitType !== "WORKER" &&
            manhattan(unit.position, enemy.position) <= SCOUT_EVADE_RADIUS,
        );
        if (samePosition(unit.position, lockPoint)) {
          if (enemyNear) {
            // 敌战斗单位近身 → 放弃锁位撤离（保命）
            this.blockadeLockedSince.delete(unit.id);
          } else if (lockedSince !== undefined && state.tick - lockedSince >= lockMaxTicks) {
            // 锁龄超限：目标一直没来（预测错误/已绕路）→ 放弃回巡逻
            this.blockadeLockedSince.delete(unit.id);
          } else {
            // 站桩锁：WAIT 占格（敌方目标格被占 → MOVE_DESTINATION_OCCUPIED）
            if (lockedSince === undefined) this.blockadeLockedSince.set(unit.id, state.tick);
            set(unit, { type: "WAIT" }, "worker_blockade");
            return;
          }
        } else {
          const direction = stepToward(unit.position, lockPoint, movementObstacles);
          if (direction !== null) {
            set(unit, { type: "MOVE", direction }, "worker_blockade");
            return;
          }
        }
      } else {
        this.blockadeLockedSince.delete(unit.id);
      }
    }

    // B13 worker 空闲回血（idleHealReturn 候选，竞品 heal priority 对照）：
    // 空 worker（无 cargo/资源任务/撤离/锁阵）HP 未满且 Core 资源足够补满时
    // 回 Core 补血——在 Core 上由主循环 HEAL 分支结算；治疗成本 1 HP=1 资源，
    // 资源不足不返航（竞品"远处单位保持原有空闲任务"）。优先级低于撤离/
    // 回仓/锁阵（见上，锁位 worker 回血会放弃锁位 → 锁断，故锁阵优先），
    // 高于采集与巡逻。
    if (
      this.config.idleHealReturn === true &&
      home !== null &&
      unit.hp < UNIT_MAX_HP[unit.unitType] &&
      state.resources >= UNIT_MAX_HP[unit.unitType] - unit.hp &&
      !samePosition(unit.position, home)
    ) {
      const direction = stepToward(unit.position, home, movementObstacles);
      if (direction !== null) set(unit, { type: "MOVE", direction }, "worker_heal_return");
      return;
    }

    if (state.resourceCells.has(cellKey(unit.position))) {
      memory.workerMode = "patrol";
      memory.harvestTarget = null;
      set(unit, { type: "HARVEST" }, "harvest");
      return;
    }

    const visibleResources = [...state.resourceCells].map((cell) => parseCell(cell));
    if (visibleResources.length > 0) {
      const target = nearest(visibleResources, unit.position);
      // 召回期间只采守家圈内的矿（远矿等威胁解除再采；breakout 全面收缩同口径，
      // 生产回流 99b4ba2 与 resourceAssignmentMaxDistanceFromCore 统一）
      if (
        Number.isFinite(maxPatrolRadius) &&
        target !== null &&
        home !== null &&
        manhattan(target, home) > maxPatrolRadius
      ) {
        memory.workerMode = "patrol";
        memory.harvestTarget = null;
      } else {
        memory.workerMode = "go_harvest";
        memory.harvestTarget = target;
        if (target !== null && !samePosition(target, unit.position)) {
          const stuckTicks = this.moveFailedStreak.get(unit.id) ?? 0;
          // W37 冲突退避时间窗（conflictBackoff）：冷却内原地 WAIT。
          if (this.config.conflictBackoff === true) {
            const backoffUntil = this.conflictBackoffUntil.get(unit.id);
            if (backoffUntil !== undefined) {
              if (backoffUntil > state.tick) {
                set(unit, { type: "WAIT" }, "conflict_backoff");
                return;
              }
              this.conflictBackoffUntil.delete(unit.id);
            }
          }
          const direction =
            this.config.moveFailedAvoidance === true && stuckTicks >= 2
              ? detourDirection(unit.position, target, movementObstacles)
              : stepToward(unit.position, target, movementObstacles);
          if (direction !== null) {
            set(unit, { type: "MOVE", direction }, "go_harvest");
          } else if (
            this.config.conflictBackoff === true &&
            stuckTicks >= (this.config.conflictBackoffThreshold ?? CONFLICT_BACKOFF_THRESHOLD)
          ) {
            this.conflictBackoffUntil.set(
              unit.id,
              state.tick + (this.config.conflictBackoffTicks ?? CONFLICT_BACKOFF_TICKS),
            );
            set(unit, { type: "WAIT" }, "conflict_backoff");
          }
        }
      }
      return;
    }

    // 幽灵矿过滤（2026-08-08，t4 生产实证）：resourceHints 含跨 run seeded 陈旧矿
    // （world.resourceCandidates 对 seeded 不设 maxAge 上限），worker 反复追早已消失的矿格→ 走到 WAIT → 换下一个 → 无限空跑
    // （生产实证 worker 在 (51,298)/(50,303) 等 seed 矿间循环 70+ tick）。只在“当前可见”或“近期见过
    // （≤ freshTicks）”时追；更旧的交给巡逻重新发现。
    const hints = this.world
      .resourceCandidates()
      .filter(
        (candidate) =>
          candidate.state === "visible" ||
          state.tick - candidate.lastSeenTick <= (this.config.harvestMemoryFreshTicks ?? HARVEST_MEMORY_FRESH_TICKS),
      )
      .map((candidate) => candidate.cell);
    if (
      memory.workerMode === "go_harvest" &&
      memory.harvestTarget !== null &&
      hints.some((hint) => samePosition(hint, memory.harvestTarget!))
    ) {
      // deterministic 上一 tick 可能执行了全局唯一资源分配，而 Safety fallback
      // 自己曾把多个 worker 记到同一个“最近可见矿”。进入记忆态时必须重新抢占
      // 真正的采集槽；后处理到的 worker 释放旧 target，回到下方重新分流/巡逻。
      if (this.config.harvestMemoryMine === true) {
        const targetKey = cellKey(memory.harvestTarget);
        const claims = this.allocatedMines.get(targetKey) ?? 0;
        if (claims >= HARVEST_MEM_TARGET_SLOTS) {
          memory.workerMode = "patrol";
          memory.harvestTarget = null;
          this.harvestMemStuck.delete(unit.id);
        } else {
          this.allocatedMines.set(targetKey, claims + 1);
        }
      }
      if (memory.harvestTarget !== null) {
      // 记忆矿卡死回退（2026-08-08，t3 生产实证 10 worker 集体 capacity_wait：
      // 记忆矿目标格容量饱和/路径被堵时，go_harvest_mem 非 patrol 意图无法
      // capacity_reroute → 永久 WAIT 死锁，经济冻结、无法产兵）。连续未推进
      // HARVEST_MEM_STUCK_TICKS 清空目标回退巡逻（重新选矿/找可见矿）。
      const prevPos = this.lastWorkerPos.get(unit.id);
      const stuck = this.harvestMemStuck.get(unit.id) ?? 0;
      const goMem = (): boolean => {
        const inRecallRange = home === null || manhattan(memory.harvestTarget!, home) <= maxPatrolRadius;
        if (inRecallRange) {
          const direction = stepToward(unit.position, memory.harvestTarget!, movementObstacles);
          if (direction !== null) set(unit, { type: "MOVE", direction }, "go_harvest_mem");
        }
        return true;
      };
      if (prevPos !== undefined && samePosition(prevPos, unit.position)) {
        this.harvestMemStuck.set(unit.id, stuck + 1);
        if (stuck + 1 >= HARVEST_MEM_STUCK_TICKS) {
          memory.workerMode = "patrol";
          memory.harvestTarget = null;
          this.harvestMemStuck.delete(unit.id);
          // 落入下方 patrol/focus 逻辑（不 return）
        } else {
          goMem();
          return;
        }
      } else {
        this.harvestMemStuck.delete(unit.id);
        goMem();
        return;
      }
      }
    }

    // 记忆矿主动开采（harvest-memory-mine-v1，2026-08-08，survey-db 联动）：
    // 无可见资源且无活跃目标时，从已知矿记忆（含跨 run 测绘 seed）挑最近的
    // 去挖——修复"矿发现了但永远不被主动去挖"（生产实证：worker 只在可见时
    // 采，巡逻错过已知矿后永不回头）。距离上限防追 70+ 格远矿（t4 实证）。
    if (
      this.config.harvestMemoryMine === true &&
      memory.harvestTarget === null &&
      (this.workerLivenessRecoveryUntil.get(unit.id) ?? 0) <= state.tick
    ) {
      const maxDist = this.config.harvestMemoryMaxDist ?? HARVEST_MEMORY_MAX_DIST;
      let best: Position | null = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const hint of hints) {
        const d = manhattan(unit.position, hint);
        // 采集吞吐感知：自然节点每 tick 只有 1 个 winner，与格子实体容量无关。
        if ((this.allocatedMines.get(cellKey(hint)) ?? 0) >= HARVEST_MEM_TARGET_SLOTS) continue;
        if (d <= maxDist && (home === null || manhattan(hint, home) <= maxPatrolRadius) && d < bestDist) {
          best = hint;
          bestDist = d;
        }
      }
      if (best !== null) {
        this.allocatedMines.set(cellKey(best), (this.allocatedMines.get(cellKey(best)) ?? 0) + 1);
        memory.workerMode = "go_harvest";
        memory.harvestTarget = best;
        if (!samePosition(unit.position, best)) {
          const direction = stepToward(unit.position, best, movementObstacles);
          if (direction !== null) set(unit, { type: "MOVE", direction }, "go_harvest_mem");
        }
        return;
      }
    }

    // W7 chunk 配额复察队（chunk-resurvey-v1，2026-08-09）：worker 无可见资源
    // 且无活跃采集目标（harvest-memory-mine 未派活）+ chunkResurvey=true 且已注入
    // refill-predictions 时，调用 planChunkResurvey 按"刷新预测 dueInTicks 升序 +
    // chunk 配额"分配 worker 去即将刷新的空矿提前占位。与 harvest-memory-mine
    // 正交：memory-mine 走"已知矿记忆可见/fresh hint"，W7 走"刷新预测 due"——
    // 前者发现已知矿后去挖，后者预测即将刷新的空矿提前蹲守。零回归：变体关闭
    // 或无注入/空预测 → planChunkResurvey 返回 [] → 不执行（保持下方 patrol）。
    if (
      this.config.chunkResurvey === true &&
      memory.harvestTarget === null &&
      this.refillPredictionsValue !== null &&
      this.refillPredictionsValue.size > 0
    ) {
      const plans = planChunkResurvey(
        this.refillPredictionsValue,
        state.workers.length,
        state.tick,
      );
      for (const plan of plans) {
        const targetCell = parseCell(plan.cell);
        const targetKey = cellKey(targetCell);
        // 一矿一 Worker 吞吐约束（与 harvest-memory-mine 同口径）：已派活的格跳过。
        if ((this.allocatedMines.get(targetKey) ?? 0) >= HARVEST_MEM_TARGET_SLOTS) continue;
        // 距离上限复用 maxPatrolRadius（与 memory-mine 同口径，防跨图远征）。
        if (home !== null && manhattan(targetCell, home) > maxPatrolRadius) continue;
        this.allocatedMines.set(targetKey, (this.allocatedMines.get(targetKey) ?? 0) + 1);
        memory.workerMode = "go_harvest";
        memory.harvestTarget = targetCell;
        if (!samePosition(unit.position, targetCell)) {
          const direction = stepToward(unit.position, targetCell, movementObstacles);
          if (direction !== null) set(unit, { type: "MOVE", direction }, "go_chunk_resurvey");
        }
        return;
      }
    }

    memory.workerMode = "patrol";
    memory.harvestTarget = null;

    // focusRegion：战略聚焦区优先于无差别巡逻（探索方向由策略层决定）
    const focus = this.effectivePolicy?.focusRegion ?? null;
    if (focus !== null && !samePosition(unit.position, focus)) {
      const direction = stepToward(unit.position, focus, movementObstacles);
      if (direction !== null) set(unit, { type: "MOVE", direction }, "go_focus");
      return;
    }

    let target: Position | null = null;
    if (home !== null) {
      const beacon = state.beacon.position ?? home;
      // worker 密集扫图（worker-dense-scan-v1）：16 方位 → 方位数/步进/目标点
      // 全部按 16 口径；默认 8 方位（EXPLORE_DIRECTION_COUNT）零回归。
      const directionCount = this.config.workerDenseScan === true ? 16 : EXPLORE_DIRECTION_COUNT;
      // W8 探索半径模式化 + wide 合并（explore-radius-wide-v1，2026-08-09）：
      // exploreRadiusWide=true 时用 WIDE_EXPLORE_DEFAULTS.exploreRadius（16）替代
      // 默认 8，让矿带中位 139 格的远矿进入巡逻覆盖（t3 事故根因：四重夹击
      // exploreRadius=8 封顶 40 格）。与 W38 hunger-gate 正交：W8 管 BFS 半径
      // （base radius），W38 管巡逻环数（patrolRing cap）——W8 放大每环半径，
      // W38 决定升到第几环。零回归：变体关闭时 exploreBase = config.exploreRadius（8）。
      const exploreBase = this.config.exploreRadiusWide === true
        ? WIDE_EXPLORE_DEFAULTS.exploreRadius
        : this.config.exploreRadius;
      let patrolRadius = exploreRadiusForRing(exploreBase, memory.patrolRing);
      // W38 饥饿门控侦察环带（hungerGate，2026-08-09）：非饥饿期（tick -
      // lastHarvest ≤ gateTicks）patrolRing 锁在 hungerNearRingCap——资源充足
      // 时宽环低效无解；饥饿（>gateTicks 无采集）放开远环到 EXPLORE_RING_COUNT。
      // 参考 heuristic.py:1595-1601（max_ring = 5 if hungry else 3）。
      if (this.config.hungerGate === true) {
        const gateTicks = this.config.hungerGateTicks ?? HUNGER_GATE_TICKS;
        const nearCap = this.config.hungerNearRingCap ?? HUNGER_NEAR_RING_CAP;
        const lastHarvest = this.lastHarvestTick.get(unit.id) ?? 0;
        const hungry = hungerGateActive(lastHarvest, state.tick, gateTicks);
        if (!hungry && memory.patrolRing > nearCap) {
          memory.patrolRing = nearCap;
          patrolRadius = exploreRadiusForRing(exploreBase, memory.patrolRing);
        }
      }
      if (maxPatrolRadius < patrolRadius) patrolRadius = maxPatrolRadius;
      let patrolPoint = this.workerPatrolPoint(home, beacon, memory.patrolDirection, patrolRadius);
      const patrolPointBlocked = obstacles.has(cellKey(patrolPoint));
      // 到达/越过当前环半径（含精确到点与绕路越界）：连续外扩到下一环——
      // 修复 2026-08-07 t4 生产实证：worker 绕路错过精确环点（chebyshev 30
      // vs 环半径 24）就被"越界→回家"截断，永远到不了 36 格资源带（res 冻
      // 在 2、全程 0 采集）。到达环带即视为"该环已完成本方向覆盖"，同方位
      // 直接延伸（8→16→24→32→40）；最外环才回家换方位。返回途中（被资源
      // 拉回等）不重新外扩——保持回家。
      if (!memory.patrolReturning && chebyshev(unit.position, home) >= patrolRadius) {
        // W38 升环门控：非饥饿期且已达 nearCap → 不升环（锁近环），保持当前
        // 巡逻点；饥饿期正常升环（放开远环覆盖）。
        const hungerGateBlocksRingUp =
          this.config.hungerGate === true &&
          memory.patrolRing >=
            (this.config.hungerNearRingCap ?? HUNGER_NEAR_RING_CAP) &&
          !hungerGateActive(
            this.lastHarvestTick.get(unit.id) ?? 0,
            state.tick,
            this.config.hungerGateTicks ?? HUNGER_GATE_TICKS,
          );
        if (!hungerGateBlocksRingUp && memory.patrolRing < EXPLORE_RING_COUNT - 1) {
          memory.patrolRing += 1;
          patrolRadius = exploreRadiusForRing(exploreBase, memory.patrolRing);
          patrolPoint = this.workerPatrolPoint(home, beacon, memory.patrolDirection, patrolRadius);
          target = patrolPoint;
        } else if (hungerGateBlocksRingUp) {
          // GAP 4.4 fix（2026-08-10）：饥饿门控阻止升环 → 步进方位扫当前环
          // 8 方位，不停在已到达的巡逻点站桩。旧版 target = patrolPoint
          // （已到达）→ stepToward 返回 null → WAIT → 卡 200 tick 不探索。
          // 方位步进 +3（与 recoverWorker 同口径）确保扫不同扇区。
          memory.patrolDirection = (memory.patrolDirection + 3) % EXPLORE_DIRECTION_COUNT;
          patrolPoint = this.workerPatrolPoint(home, beacon, memory.patrolDirection, patrolRadius);
          target = patrolPoint;
        } else {
          memory.patrolReturning = true;
          target = home;
        }
      // 返航空载 worker 不踏入核心格（2026-08-08，t4 振荡复现）：旧逻辑
      // patrolReturning 时 target=home → stepToward 直穿核心格 → 与
      // worker_clear_core_empty 对穿振荡（t4 实证 res 冻 2、deposit=0）。
      // 空载返航到 home 邻格（chebyshev<=1）即视为已到家 → 直接换方位出发；
      // 满载卸货走 cargo 分支（不经此处），不受影响。
      } else if (
        samePosition(unit.position, home) ||
        (memory.patrolReturning && (unit.cargo ?? 0) === 0 && chebyshev(unit.position, home) <= 1)
      ) {
        if (memory.patrolStarted) {
          // 方位步进 1→3（2026-08-06 生产实证）：t1 资源枯竭时 40 格矿在正东，
          // 旧连续步进（+1）按 beacon 方位基（东南）逐格推进，第 8 圈才轮到正东
          // （数百 tick 不可达）——4 worker 首圈聚集东南-西 4 方位造成测绘盲区；
          // +3（与 8 互质）前 3 圈即扫过全部 8 方位，分散覆盖。
          // frontier-v1（实验）：观察最老的分区先巡——8 方位按当前环探测点所在
          // chunk 老化排序，worker 按序号轮转分散（默认 false 保持 +3 固定步进）。
          memory.patrolDirection =
            this.config.frontierPriority === true
              ? this.world.staleDirection(
                  home,
                  beacon,
                  memory.patrolRing,
                  this.config.exploreRadius,
                  directionCount,
                  // 分散偏移与初始方向同构（(index*3+7)%N 生产验证的分散方案）：
                  // 纯 index 位次会让全部 worker 涌向"最老"位次（实验实证：
                  // 双对角远矿场景 east 0/3 west 3/3——东侧被集体放弃）；
                  // 固定偏移保证不同 worker 取不同老化位次，老方位优先 + 覆盖分散。
                  (index * 3 + 7) % directionCount,
                )
              : this.config.workerDenseScan === true
                ? (memory.patrolDirection + 6) % directionCount
                : (memory.patrolDirection + 3) % directionCount;
          memory.patrolRing = (memory.patrolRing + 1) % EXPLORE_RING_COUNT;
        }
        else memory.patrolStarted = true;
        memory.patrolReturning = false;
        patrolRadius = exploreRadiusForRing(exploreBase, memory.patrolRing);
        patrolPoint = this.workerPatrolPoint(home, beacon, memory.patrolDirection, patrolRadius);
        target = patrolPoint;
      } else if (memory.patrolReturning) {
        target = home;
      } else if (
        samePosition(unit.position, patrolPoint) ||
        (patrolPointBlocked && chebyshev(unit.position, patrolPoint) <= 1)
      ) {
        // 连续外扩巡逻（2026-08-06 用户导向）：到达当前环点后不回 home——
        // 同方位直接延伸下一环（8→16→24→32→40 连续外扩，"一直往外探索"；
        // 旧行为每环往返 home 换环，视觉上来回、推进慢、测绘覆盖滞后）。
        // 到最远环后回家换方位重头。
        if (memory.patrolRing < EXPLORE_RING_COUNT - 1) {
          memory.patrolRing += 1;
          patrolRadius = exploreRadiusForRing(exploreBase, memory.patrolRing);
          patrolPoint = this.workerPatrolPoint(home, beacon, memory.patrolDirection, patrolRadius);
          target = patrolPoint;
        } else {
          memory.patrolReturning = true;
          target = home;
        }
      } else {
        target = patrolPoint;
      }
    } else {
      target = state.beacon.position;
    }

    if (target !== null && !samePosition(target, unit.position)) {
      // 巡逻出发错峰（2026-08-08，t2 生产实证）：离 home ≤3 格且 2 格内 worker
      // ≥5（核心区拥挤）且存在比自己更靠外的邻居 → 原地 WAIT 错峰，让外圈先
      // 疏散（至少最靠外的 worker 无更外邻居 → 正常出发，不会全 WAIT）。防
      // "重启后 12 worker 同步出发 → 出口容量互堵 → 永久卡死"。
      if (
        home !== null &&
        target !== home &&
        // 核心格上的 worker 豁免错峰（2026-08-08，t2 卸货通道死锁实证）：
        // 占核心格 = 占死卸货唯一通道，必须离开让位——错峰 WAIT 会让它永远
        // 卡在核心格（4 满载 worker 围死 ring 时 hasOuter 恒真 → worker_hold_crowded
        // 恒 WAIT → deposit=0 经济冻结）。
        !samePosition(unit.position, home) &&
        chebyshev(unit.position, home) <= PATROL_DEPARTURE_RADIUS
      ) {
        const crowded = state.workers.filter(
          (w) => w.id !== unit.id && manhattan(w.position, unit.position) <= 2,
        ).length;
        if (crowded >= PATROL_DEPARTURE_CROWD) {
          const myDist = manhattan(unit.position, home);
          const hasOuter = state.workers.some(
            (w) =>
              w.id !== unit.id &&
              manhattan(w.position, unit.position) <= 2 &&
              manhattan(w.position, home) > myDist,
          );
          if (hasOuter) {
            set(unit, { type: "WAIT" }, "worker_hold_crowded");
            return;
          }
        }
      }
      // 巡逻不穿核心格（2026-08-08，t3 振荡修复）：空载 worker 去巡逻点时若
      // 目标在核心对侧，stepToward 第一步会穿回核心格（生产格）→ 与
      // worker_clear_core_empty 交替振荡（t3 实证 pop 冻结 1、res 恒 5、
      // emergency_spawn_worker/worker_clear_core_empty 每 tick 互切 100+ tick）。
      // 去巡逻点（target !== home）且非满载时把核心格临时视为禁入——BFS 自动
      // 绕行，不再穿核心格。满载回核心卸货走 cargo 分支（不经此处），不受影响。
      const patrolObstacles =
        home !== null && target !== home && (unit.cargo ?? 0) === 0
          ? new Set(movementObstacles).add(cellKey(home))
          : movementObstacles;
      const direction = stepToward(unit.position, target, patrolObstacles);
      if (direction !== null) {
        set(unit, { type: "MOVE", direction }, "patrol");
      } else {
        // 巡逻目标不可达（2026-08-08，t4 生产实证：worker 停墙边/墙角 70+ tick）：
        // ring 推进让 chebyshev 已到 radius，worker 保持静止却永远到不了精确点 → WAIT。
        // 修复：转方位 +1，下一 tick 试新目标点；敌方在途时依然推进。
        const dirCount = this.config.workerDenseScan === true ? 16 : EXPLORE_DIRECTION_COUNT;
        memory.patrolDirection = (memory.patrolDirection + 1) % dirCount;
      }
    }
  }

  private decideVanguard(
    state: TickState,
    unit: UnitSnapshot,
    index: number,
    obstacles: ReadonlySet<string>,
    enemies: readonly VisibleEntity[],
    set: (unit: UnitSnapshot, action: UnitAction, intent: string) => void,
  ): void {
    const movementObstacles = this.world.movementObstacles(unit.id, obstacles);
    // 军事单位绕开自家 Core 格（2026-08-07 生产 t2 实证）：Core 格是
    // Worker 回仓/SPAWN 出生通道——军事单位穿越（如让位回归路径穿过
    // Core 格）会与同 tick SPAWN 冲突 CELL_UNIT_LIMIT → 每 2 tick 一次
    // spawn 失败循环（单 run 26 次）。回 Core 的接近目标 = Core 邻格
    // （homeCell——Core 格本身是军事禁区）；四邻全堵回退 Core 格。
    const militaryObstacles = state.core === null
      ? movementObstacles
      : new Set([...movementObstacles, cellKey(state.core.position)]);
    // GAP 5.1 fix（2026-08-10）：C7 军事卡死 spread——checkMilitaryStuckSpread
    // 定义后从未被调用（dead code）→ 军事单位 capacity_wait 无限循环无恢复。
    // 在所有决策分支之前调用：streak ≥ MILITARY_STUCK_TICKS(3) 且无邻接敌时
    // 强制 spread 到相邻空格，打断 WAIT 死循环。
    if (this.checkMilitaryStuckSpread(unit, state, militaryObstacles, enemies, set)) return;
    // 核心通道清障（core-clearance-v1）：homeCell 四邻全堵时历史行为回退到核心
    // 格（占死卸货通道）——coreClearance 下回退到外圈守位点，军事绝不落核心格。
    // C7 修复（2026-08-10）：军事单位卡死 spread——连续 N tick 位置不变 +
    // 无邻接敌 → spread 到相邻空格，打断 capacity_wait 无限循环。
    if (this.checkMilitaryStuckSpread(unit, state, militaryObstacles, enemies, set)) return;

    // ring 疏散（2026-08-08，t2 卸货通道死锁实证）：核心格被 worker 占用（空载
    // idle 或满载待卸）= 卸货通道已被占死，守位退到 Chebyshev 2（coreGuardFallback
    // 优先）腾出 cheb-1 ring——否则 4 Vanguard 挤满 ring，被困空 worker 4 邻全堵
    // 永远走不出核心格，deposit=0 经济冻结。
    const coreOccupiedByWorker = state.core !== null && state.units.some(
      (u) => u.unitType === "WORKER" && samePosition(u.position, state.core!.position),
    );
    const approachTarget = state.core === null
      ? null
      : (this.migrationMoving
          ? guardHomeCell(state.core.position, militaryObstacles, index, this.migrationPathAhead(state.core.position))
          : null)
        ?? (this.config.coreClearance === true && coreOccupiedByWorker
          ? (this.coreGuardFallback(state.core.position, militaryObstacles, index)
             ?? homeCell(state.core.position, militaryObstacles, index))
          : homeCell(state.core.position, militaryObstacles, index)
            ?? (this.config.coreClearance === true
              ? this.coreGuardFallback(state.core.position, militaryObstacles, index)
              : state.core.position));
    // 寡不敌众撤退（outnumbered-retreat-v1，2026-08-08）：非守家单位遇可见敌
    // 战斗单位且附近我方军事 < 敌 → 向家撤退（绕开敌人占位，stepToward 障碍集
    // 含敌格）——防 1v2+ 单薄送死。守家圈（≤4）单位不撤（最后防线接战）；敌核
    // 守军不计入（攻坚不因目标守军撤退）。置于 SWEEP 之前：劣势遭遇战先止损。
    if (this.config.outnumberedRetreat === true && this.outnumbered(state, unit, enemies)) {
      const retreatObstacles = new Set(militaryObstacles);
      for (const enemy of enemies) retreatObstacles.add(cellKey(enemy.position));
      const direction = stepToward(unit.position, state.core!.position, retreatObstacles);
      if (direction !== null) { set(unit, { type: "MOVE", direction }, "vanguard_outnumbered_retreat"); return; }
    }
    const adjacent = enemies.find((enemy) => manhattan(unit.position, enemy.position) === 1);
    if (adjacent !== undefined) {
      const direction = directionToAdjacent(unit.position, adjacent.position);
      if (direction !== null) set(unit, { type: "SWEEP", direction }, "sweep");
      return;
    }

    // 核心通道清障（core-clearance-v1，2026-08-07）：本 Vanguard 站在核心格上
    // → 立即疏散到最近空邻格/外圈（让位给满载 worker 卸货）。核心格容量 2
    // （含 Core）且是卸货/SPAWN 唯一通道，军事占核心格 = 卸货死锁（生产 t2
    // 实证：Vanguard 占核心格 → 满载 worker 4 邻格全 WAIT、DEPOSIT_FAILED
    // 77%，手操移开下 tick 又被放回）。SWEEP 已在上方处理邻接敌。
    if (
      this.config.coreClearance === true &&
      state.core !== null &&
      samePosition(unit.position, state.core.position)
    ) {
      const exit = homeCell(state.core.position, movementObstacles, index)
        ?? this.coreGuardFallback(state.core.position, movementObstacles, index);
      if (exit !== null && !samePosition(unit.position, exit)) {
        const direction = stepToward(unit.position, exit, movementObstacles);
        if (direction !== null) { set(unit, { type: "MOVE", direction }, "vanguard_clear_core"); return; }
      }
    }

    // ring 疏散（core-clearance-v1 补强，2026-08-08，t2 卸货通道死锁实证）：核心格
    // 被 worker 占用（空载 idle 或满载待卸）= 卸货通道被占死。cheb-1 ring 上的
    // 军事单位退到 Chebyshev 2（coreGuardFallback）让出核心邻格——否则 Vanguard
    // 守位锚点 homeCell 就是 cheb-1（四邻轮转把自己钉在 ring 上），被困空 worker
    // 4 邻全堵永远走不出核心格 → deposit=0 经济冻结（生产 t2 实证 130+ tick）。
    // 邻接敌由上方 SWEEP 分支优先反击（战斗不丢）；仅核心格被 worker 占用时
    // 触发，正常守位零回归。
    if (
      this.config.coreClearance === true &&
      state.core !== null &&
      coreOccupiedByWorker &&
      chebyshev(unit.position, state.core.position) === 1 &&
      !samePosition(unit.position, state.core.position)
    ) {
      const post = this.coreGuardFallback(state.core.position, militaryObstacles, index);
      if (
        post !== null &&
        !samePosition(post, state.core.position) &&
        !samePosition(unit.position, post)
      ) {
        const direction = stepToward(unit.position, post, militaryObstacles);
        if (direction !== null) { set(unit, { type: "MOVE", direction }, "vanguard_ring_clear"); return; }
      }
    }

    // 远端军事回援（remoteReinforce 候选，竞品 "敌方战斗单位已经进入 Core
    // 防区时，所有非守家单位跳过集结等待并立即回援"）：可见敌方战斗单位进入
    // Core 防区（12 = THREAT_FALLBACK_RADIUS）→ 远端 Vanguard 立即回 Core
    // 守位——优先于攻坚/打野/环搜（家被拆一切白搭）。触发后保持回援 8 tick
    // （防敌人闪失→立刻折返抖动）；返回期间邻接敌仍由上方 SWEEP 分支反击。
    if (this.shouldReinforce(state, unit, enemies)) {
      const direction = stepToward(unit.position, approachTarget ?? state.core!.position, militaryObstacles);
      if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_reinforce");
      return;
    }

    // 信标夺取（beaconGrab 候选，官方 Champion Beacon 机制对齐）：信标近距离
    // （≤ beaconGrabMaxDist）时最近 Vanguard 前往拾取——拾取后信标跟随移动，
    // 载者回 Core 守位（见 return 分支）。优先级高于攻坚/打野：持标 buff
    // （盾 10 + 采集 2×）是全局经济/防御收益。返回期间邻接敌仍 SWEEP 反击。
    const beaconTask = this.beaconMission(state, unit);
    if (beaconTask !== null) {
      const target = beaconTask === "return"
        ? (approachTarget ?? state.core!.position)
        : state.beacon.position;
      const intent = beaconTask === "return" ? "vanguard_beacon_return" : "vanguard_beacon_fetch";
      if (beaconTask === "return" && state.core !== null && manhattan(unit.position, state.core.position) <= REINFORCE_HOME_RING) {
        // 已持标且到家（守家圈内）：持标待命——不带着信标满图跑（避免信标
        // 被拖进敌方射程/丢失）。邻接敌仍由上方 SWEEP 反击。
        set(unit, { type: "WAIT" }, "vanguard_beacon_hold");
        return;
      }
      const direction = stepToward(unit.position, target, militaryObstacles);
      if (direction !== null) set(unit, { type: "MOVE", direction }, intent);
      return;
    }

    // 信标护送（beacon-escort，2026-08-08）：护送者贴身影护设计者/载者（≤2
    // 格）。优先级高于攻坚/打野——护标即护全局 buff（盾 10 + 采集 2×）。
    const escortTask = this.beaconEscortMission(state, unit);
    if (escortTask !== null) {
      const target = escortTask.designeePos;
      const intent = "vanguard_beacon_escort";
      const d = chebyshev(unit.position, target);
      if (d <= 2) { set(unit, { type: "WAIT" }, intent); return; }
      const direction = stepToward(unit.position, target, militaryObstacles);
      if (direction !== null) set(unit, { type: "MOVE", direction }, intent);
      return;
    }

    // VANGUARD 预判拦截（vanguard-blockade-v1，2026-08-08，手操实战实证）：
    // 本 tick 配对到拦截点的 Vanguard → 走向拦截点站桩——敌方 worker 撞上
    // （MOVE_DESTINATION_OCCUPIED）被卡，邻接时上方 SWEEP 分支自动攻击
    // （锁+收割一体）。站桩锁龄超限（预测错误/目标转向）→ 放弃回巡逻。
    // 防御优先：reinforce/beacon/escort 已在上方处理；邻接敌 SWEEP 优先。
    if (this.config.vanguardBlockade === true) {
      const lockPoint = this.vanguardBlockadeAssignment.get(unit.id);
      if (lockPoint !== undefined) {
        const lockMaxTicks = this.config.vanguardBlockadeMaxTicks ?? VANGUARD_BLOCKADE_MAX_TICKS;
        const lockedSince = this.vanguardBlockadeLockedSince.get(unit.id);
        if (samePosition(unit.position, lockPoint)) {
          if (lockedSince !== undefined && state.tick - lockedSince >= lockMaxTicks) {
            this.vanguardBlockadeLockedSince.delete(unit.id);
          } else {
            if (lockedSince === undefined) this.vanguardBlockadeLockedSince.set(unit.id, state.tick);
            set(unit, { type: "WAIT" }, "vanguard_blockade");
            return;
          }
        } else {
          const direction = stepToward(unit.position, lockPoint, militaryObstacles);
          if (direction !== null) {
            set(unit, { type: "MOVE", direction }, "vanguard_blockade");
            return;
          }
        }
      } else {
        this.vanguardBlockadeLockedSince.delete(unit.id);
      }
    }

    if (this.effectiveAggression === "aggressive") {
      // 清剿可见敌方 WORKER（vanguardPreyWorker，2026-08-08，用户"挂机/落单
      // 单位赶紧打掉"）：可见敌 WORKER（断经济 + 无反击，白赚）在
      // PREY_WORKER_RADIUS 内且不在敌核心记忆 PREY_CORE_SAFE 格内（避开守军）
      // → 最近 Vanguard 优先追击清剿，高于蓄势/打野。其余 Vanguard 照常
      // （防扎堆：只让距离最近的 1 个去）。邻接敌已被上方 SWEEP 分支处理。
      if (this.config.vanguardPreyWorker === true && state.core !== null) {
        // 最近猎手-猎物配对（2026-08-08 优化）：所有可见敌 WORKER 里选"距任一
        // Vanguard 最近"的一个——旧版 enemies.find 取列表第一个，若第一个很远但
        // 另一个在 12 格内会漏猎。再只让离它最近的 1 个 Vanguard 追击（防扎堆）。
        let prey: (typeof enemies)[number] | undefined;
        let preyDist = Infinity;
        for (const enemy of enemies) {
          if (enemy.kind !== "UNIT" || enemy.unitType !== "WORKER") continue;
          for (const v of state.vanguards) {
            const d = manhattan(v.position, enemy.position);
            if (d < preyDist) { preyDist = d; prey = enemy; }
          }
        }
        if (prey !== undefined && preyDist <= PREY_WORKER_RADIUS) {
          // 只认 CORE 来源目标（WORKER_INFER 是从该 WORKER 本身推断的基地候选，
          // 位置≈WORKER，会误判"在敌核心旁"导致永不追击——2026-08-08 实测）。
          const nearEnemyCore = this.world.coreHuntTargets().some(
            (target) => target.source === "CORE" && chebyshev(target.position, prey.position) <= PREY_CORE_SAFE,
          );
          if (!nearEnemyCore) {
            const nearest = [...state.vanguards]
              .sort((a, b) => manhattan(a.position, prey.position) - manhattan(b.position, prey.position))[0];
            if (nearest !== undefined && nearest.id === unit.id) {
              const direction = stepToward(unit.position, prey.position, militaryObstacles);
              if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_prey_worker");
              return;
            }
          }
        }
      }
      // 近核入侵回访（2026-08-08，core-threat-watch-v1）：观察内敌单位（战斗
      // 单位 camp 或超出短窗口的静止 WORKER camp）距我方 Core ≤ 观察半径——
      // 派最近 1 个 Vanguard 回访确认并清剿。**近核威胁属防御，绕过远征
      // attackForce gate**（strike-core-v1 attackForce=6 会让 t2 5 个 Vanguard
      // 全部 vanguard_hold 蓄势，贴脸 600+ tick 的敌 WORKER camp 无人清——
      // 用户裁决"挂机单位赶紧打掉，不赚白不赚"）。短窗口静止 WORKER
      // （≤PREY_STATIONARY_TTL）由 vanguard_prey_worker_stationary 处理，这里
      // 只接超出短窗口的盘踞目标（TTL 60）与战斗单位 camp，避免重复扎堆。
      if (this.config.coreThreatWatch === true && enemies.length === 0 && state.core !== null) {
        const watchTicks = this.config.coreThreatWatchTicks ?? CORE_THREAT_WATCH_TICKS;
        const watchRadius = this.config.coreThreatWatchRadius ?? CORE_THREAT_WATCH_RADIUS;
        const watch = this.world
          .coreWatchTargets(watchTicks)
          .filter((w) => w.kind === "UNIT")
          .filter((w) => {
            if (w.unitType === "WORKER") {
              return w.stationary && state.tick - w.lastSeenTick > PREY_STATIONARY_TTL;
            }
            return w.unitType !== undefined;
          })
          .filter((w) => !enemies.some((e) => e.id === w.id))
          .filter((w) => manhattan(w.position, state.core!.position) <= watchRadius);
        const candidate = watch
          .map((w) => ({ w, d: manhattan(unit.position, w.position) }))
          .sort((a, b) => a.d - b.d || a.w.id.localeCompare(b.w.id))[0];
        if (candidate !== undefined && candidate.d <= PREY_STATIONARY_RADIUS) {
          const nearEnemyCore = this.world.coreHuntTargets().some(
            (t) => t.source === "CORE" && chebyshev(t.position, candidate.w.position) <= PREY_CORE_SAFE,
          );
          if (!nearEnemyCore) {
            const nearest = [...state.vanguards]
              .sort((a, b) => manhattan(a.position, candidate.w.position) - manhattan(b.position, candidate.w.position))[0];
            if (nearest !== undefined && nearest.id === unit.id) {
              const direction = stepToward(unit.position, candidate.w.position, militaryObstacles);
              if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_watch_clear");
              return;
            }
          }
        }
      }
      // 爆兵蓄势 gate（2026-08-06 用户导向"以爆兵为目的打对面水晶"）：军事
      // 规模未达 attackForce 时守家蓄势（兵力成型再前压，避免零星送死）；
      // 达标后前压攻坚。默认 attackForce=0 = 关闭（历史行为）。
      const military = state.vanguards.length + state.rangers.length;
      // 威胁自适应（2026-08-07）：攻坚目标所有者是排行榜高伤害玩家（猛攻蛆）
      // 时提高成型门槛——成建制更足才前压（防单薄送死 + 防远征时被偷家）。
      const force = this.adaptiveAttackForce();
      const forceGate = force > 0 && military < force;
      if (forceGate) {
        const home = state.core === null
          ? null
          : homeCell(state.core.position, militaryObstacles, index)
            ?? (this.config.coreClearance === true
              ? this.coreGuardFallback(state.core.position, militaryObstacles, index)
              : state.core.position);
        if (home !== null && !samePosition(unit.position, home)) {
          const direction = stepToward(unit.position, home, militaryObstacles);
          if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_hold");
        }
        return;
      }
      // B7 守卫预留（strikeGroupReserve 候选，竞品 _strike_group_ids 对照）：
      // 攻坚时按 id 排序保留 N 个 Vanguard 守家（官方拆家留守卫
      // VANGUARD_CORE_GUARDS=1 防换家/反打；威胁自适应叠加到 2——高伤害对手
      // 趁远征偷家/反打的概率更高），其余全压拆家——家不空防。
      // home-guard-squad-v1（2026-08-09 用户裁决"守卫至少 2 前锋 1 游侠"）：
      // 守卫选择从 UUID 排序改为"距 Core 最近"排序——UUID 随机可能选中远征
      // 前线的单位（t1 生产实证 dist=92 守卫，名义留守实际裸奔）。距离选择
      // 保证"留守最近的兵、远征用最远的兵"。Ranger 守卫在 decideRanger。
      const reserveGuards = (this.config.homeGuardSquad === true || this.config.tacticalSquads === true)
        ? this.config.homeGuardVanguards ?? 4
        : this.adaptiveReserveGuards(state);
      const reserveGuard = state.core !== null && this.isHomeGuardUnit(state, unit, reserveGuards);
      if (reserveGuard) {
        // guard-spacing-v1（2026-08-09 用户裁决）：守卫站核心外环（Chebyshev
        // 2-3 四角优先），4 邻格让给核心移动/worker 卸货通道——贴脸站位会把
        // 核心堵死（迁移实证：守卫站核心行进方向前方格 → 引擎容量拒 → 停滞）。
        // guard-corner-spacing-v1（2026-08-10 用户裁决"近卫军分散核心四角
        // 3-5 格站岗，不堵 2 格内"）：cornerSpacing=true → 2 环完全让出，
        // 守位从 3 环四角起步（3-5 环四角优先）。
        // migration-lane-v1：迁移激活期额外避开核心路径前方 3 格（核心将
        // 踩过的格不能被占——t1 实证守卫站路径前方对角格 → START_FAILED）。
        const avoid = this.migrationMoving ? this.migrationPathAhead(state.core.position) : undefined;
        const home = state.core === null
          ? null
          : guardHomeCell(state.core.position, militaryObstacles, index, avoid, true)
            ?? (this.config.coreClearance === true
              ? this.coreGuardFallback(state.core.position, militaryObstacles, index)
              : state.core.position);
        if (home !== null && !samePosition(unit.position, home)) {
          const direction = stepToward(unit.position, home, militaryObstacles);
          if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_home_guard");
        }
        return;
      }
      // 敌方 Core 记忆推进（2026-08-07 竞品 offensive memory 对齐）：aggressive
      // 且当前无可见敌人时，若曾见过敌方 Core（记忆未过期），向记忆位置推进——
      // 避免"敌人离开视野后 Vanguard 只在自家 Core 附近巡逻"的盲区（模拟器
      // v0.14 实证：无敌人时 scavenge 巡逻方向随机，可能完全背离敌方）。
      // Core 是慢速目标，记忆有效期放宽到 60 ticks（单位记忆默认 6）。
      // 优先级高于守家巡逻：有攻坚目标时不空转。
      if (enemies.length === 0 && state.core !== null) {
        const enemyCoreMemory = this.world.enemyHints(this.config.enemyCoreMemoryTicks ?? 60).find((hint) => hint.kind === "CORE");
        if (enemyCoreMemory !== undefined) {
          // B6 有界攻坚（boundedRaid 候选，竞品 "exceeds the bounded mission
          // distance" → withdraw）：记忆中的敌 Core 距我方 Core 超上限（40 格）
          // = 远征送死（补给线长、守军集火）——取消攻坚回 Core 守位。
          if (
            this.config.boundedRaid === true &&
            chebyshev(state.core.position, enemyCoreMemory.position) > BOUNDED_RAID_DISTANCE
          ) {
            const direction = stepToward(unit.position, approachTarget ?? state.core.position, militaryObstacles);
            if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_bounded_return");
            return;
          }
          // 攻坚集结（2026-08-08，rally-assault-v1）：组未齐且本单位还在敌核攻击圈
          // 外 → 先到敌核外圈安全集结位汇合，组齐/超时后成建制压上（防逐个送死）。
          const key = cellKey(enemyCoreMemory.position);
          if (
            this.config.rallyAssault === true &&
            !this.rallyReady(enemyCoreMemory.position, key, state, unit) &&
            chebyshev(unit.position, enemyCoreMemory.position) > RALLY_ATTACK_RADIUS
          ) {
            const point = this.rallyPointForUnit(unit, enemyCoreMemory.position, state.core.position, militaryObstacles, state.resourceCells);
            if (!samePosition(unit.position, point)) {
              const direction = stepToward(unit.position, point, militaryObstacles);
              if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_rally");
              return;
            }
            set(unit, { type: "WAIT" }, "vanguard_rally_hold");
            return;
          }
          const direction = stepToward(unit.position, enemyCoreMemory.position, militaryObstacles);
          if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_pressure_memory");
          return;
        }
      }
      // 军事打野（2026-08-06 用户导向）：aggressive + 无可见敌人 + 资源枯竭
      // （视野 0 资源格）——军事单位不再守家发呆，巡逻外扩探索（测绘 + 打野）；
      // 有资源仍守家（防止军事单位长期远征离家被端）、有敌人走前压。
      // 修复（2026-08-06 模拟器实证）：旧条件 samePosition(unit, target) 要求
      // Vanguard 先走到 target（无敌人时 = Core 格）才打野——守家锚点在途/
      // Core 格被 Worker 回仓占用时永远到不了 → 打野永不触发、Vanguard 枯竭后
      // 空转守家。无敌人时 target 恒为 Core 位置，该到位限制无意义。
      // GAP 5.3 fix（2026-08-10，t1 生产实证 tick 83782）：资源枯竭判定从
      // `size === 0` 放宽为"可见资源 < worker 采集需求"——旧版只有 0 可见资源
      // 才打野，t1 视野常年 4 格可见资源（< 17 worker 需求）→ 22+ Vanguard
      // 全部守家空转（守家锚点 4 格容量 2×4=8 严重超订 → pressure_spread 互堵），
      // 不打野 → 地图不扩展 → 发现资源少 → 经济饿死。资源不足时非守卫军事
      // （守卫由上方 homeGuardSquad 分支留守）打野扩展测绘。
      const resourceScarce = state.resourceCells.size < state.workers.length;
      if (enemies.length === 0 && resourceScarce && state.core !== null) {
        // W62 环形扇区扫荡（assault-sector-sweep-v1，2026-08-09，竞品
        // `_assault_frontier_target` :6955 对照）：aggressive 军事打野改用
        // 全队共享前沿航点（半径振荡 + 扇区旋转 + 全员到齐门控），替代 per-unit
        // patrolRing 散开各自升环。置于 militaryHunt 之后（敌情狩猎优先回访已知
        // 敌基地）、per-unit scavenge 之前（W62 是 scavenge 的共享几何升级）。
        if (this.config.assaultSectorSweep === true && this.effectiveAggression === "aggressive") {
          const sweepTarget = this.assaultFrontierTarget(state, militaryObstacles);
          if (sweepTarget !== null) {
            const direction = stepToward(unit.position, sweepTarget, militaryObstacles);
            if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_sector_sweep");
            return;
          }
        }
        // 敌情狩猎（militaryHunt，2026-08-07 持久敌情测绘）：优先回访最后已知
        // 敌基地（CORE 目击 sticky + Worker 轨迹推断锚点），而不是从自家 Core
        // 盲目环搜。清扫语义：进入清扫圈停留 HUNT_SWEEP_TICKS 仍未发现敌 Core
        // → 记清扫旋转下一目标；目标被重新目击（lastSeenTick 更新）→ 恢复狩猎。
        if (this.config.militaryHunt === true) {
          const hunt =
            this.config.weakCoreFirst === true
              ? this.weakCoreOrderedTargets(state)
              : this.world.coreHuntTargets();
          // W10 斩首配额（sortie-quota-v1）：开启时单位编入 sortie 按家防余量
          // 分流不扑同一弱核；未编入 sortie 的单位不扑弱核（fall through 到
          // prey/scavenge/home）。关闭时历史 .find 行为（零回归）。
          const target = this.config.sortieQuota === true
            ? this.sortieTargetFor(unit, hunt, state)
            : hunt.find((t) => {
                const sweptAt = this.huntSweptAt.get(cellKey(t.position));
                return sweptAt === undefined || t.lastSeenTick > sweptAt;
              });
          if (target !== undefined) {
            // sortie 编入单位直奔目标（无清扫旋转——sortie 是 committed assault）；
            // 关闭时走清扫语义（历史行为）。
            if (this.config.sortieQuota === true) {
              const direction = stepToward(unit.position, target.position, militaryObstacles);
              if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_sortie");
              else set(unit, { type: "WAIT" }, "vanguard_sortie");
              return;
            }
            const key = cellKey(target.position);
            const reach = chebyshev(unit.position, target.position);
            if (reach <= HUNT_SWEEP_RADIUS) {
              const arrival = this.huntArriveAt.get(unit.id);
              if (arrival === undefined || arrival.key !== key) {
                this.huntArriveAt.set(unit.id, { key, tick: state.tick });
              } else if (state.tick - arrival.tick >= HUNT_SWEEP_TICKS) {
                this.huntSweptAt.set(key, state.tick);
                this.huntArriveAt.delete(unit.id);
              }
            }
            const point = this.huntSweepPoint(target.position, index, reach);
            const direction = stepToward(unit.position, point, militaryObstacles);
            if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_hunt");
            return;
          }
          // 挂机 WORKER 回访（vanguardPreyWorker 扩展，2026-08-08，用户"挂机单位
          // 赶紧打掉"）：无敌核清扫目标时，回访"确认静止"（连续目击同位置）的
          // 敌方 WORKER——白赚断经济（无反击）。TTL/半径有界；敌核心记忆 8 格内
          // 不追（避守军，与可见 prey 同守卫）。每 Vanguard 选自己最近的静止
          // WORKER，天然分散清剿（不同 Vanguard 去不同目标）。
          if (this.config.vanguardPreyWorker === true) {
            const stationary = this.world
              .stationaryWorkerTargets(PREY_STATIONARY_TTL)
              .filter((w) => !enemies.some((e) => e.id === w.id));
            const candidate = stationary
              .map((w) => ({ w, d: manhattan(unit.position, w.position) }))
              .filter((x) => x.d <= PREY_STATIONARY_RADIUS)
              .sort((a, b) => a.d - b.d || a.w.id.localeCompare(b.w.id))[0];
            if (candidate !== undefined) {
              const nearEnemyCore = this.world.coreHuntTargets().some(
                (t) => t.source === "CORE" && chebyshev(t.position, candidate.w.position) <= PREY_CORE_SAFE,
              );
              if (!nearEnemyCore) {
                const nearest = [...state.vanguards]
                  .sort((a, b) => manhattan(a.position, candidate.w.position) - manhattan(b.position, candidate.w.position))[0];
                if (nearest !== undefined && nearest.id === unit.id) {
                  const direction = stepToward(unit.position, candidate.w.position, militaryObstacles);
                  if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_prey_worker_stationary");
                  return;
                }
              }
            }
          }
        }
        const dense = this.config.militarySearchDense === true;
        const directionCount = dense ? 16 : EXPLORE_DIRECTION_COUNT;
        const home = state.core.position;
        const beacon = state.beacon.position ?? home;
        // 陈旧区块优先（military-frontier-scavenge-v1，2026-08-08）：打野方位
        // 按"当前环探测点所在 chunk 观察老化"选最旧区块，替代固定分散方位。
        const memory = this.world.unitMemory(
          unit.id,
          this.militaryScavengeDirection(home, beacon, 0, index, directionCount),
        );
        let patrolRadius = exploreRadiusForRing(this.config.exploreRadius, memory.patrolRing);
        let patrolPoint = dense
          ? exploreTargetDense(home, beacon, memory.patrolDirection, patrolRadius)
          : exploreTarget(home, beacon, memory.patrolDirection, patrolRadius);
        // 环推进触发：到达精确巡逻点（历史行为）**或**同环停留超时间预算
        // （militaryRingHoldTicks，2026-08-07——破争格/振荡导致的"永不到点、
        // 永不升环、搜索不外扩"；t1 生产实证 8 个 Vanguard 全部卡在 Core
        // 8 格内小振荡）。升环后重置停留计时。
        const ringSince = this.unitRingSince.get(unit.id) ?? state.tick;
        const ringHoldExceeded =
          (this.config.militaryRingHoldTicks ?? SCAVENGE_HOLD_TICKS) > 0 &&
          state.tick - ringSince >= (this.config.militaryRingHoldTicks ?? SCAVENGE_HOLD_TICKS);
        if (samePosition(unit.position, patrolPoint) || ringHoldExceeded) {
          this.unitRingSince.set(unit.id, state.tick);
          if (memory.patrolRing < EXPLORE_RING_COUNT - 1) {
            memory.patrolRing += 1;
            patrolRadius = exploreRadiusForRing(this.config.exploreRadius, memory.patrolRing);
            patrolPoint = dense
              ? exploreTargetDense(home, beacon, memory.patrolDirection, patrolRadius)
              : exploreTarget(home, beacon, memory.patrolDirection, patrolRadius);
          } else {
            memory.patrolRing = 0;
            memory.patrolDirection = this.config.militaryScavengeFrontier === true
              ? this.world.staleDirection(
                  home,
                  beacon,
                  memory.patrolRing,
                  this.config.exploreRadius,
                  directionCount,
                  (index * 3 + 7) % directionCount,
                )
              : (memory.patrolDirection + 3) % directionCount;
            patrolPoint = dense
              ? exploreTargetDense(home, beacon, memory.patrolDirection, patrolRadius)
              : exploreTarget(home, beacon, memory.patrolDirection, patrolRadius);
          }
        }
        const direction = stepToward(unit.position, patrolPoint, militaryObstacles);
        if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_scavenge");
        return;
      }
      // 激进：主动前压。attackPriority 决定攻坚目标（v0.9 拆 Core 掠夺资源 vs
      // 断敌经济）；无特攻目标时追击最近可见敌人。不再因靠近自家 Core 而留守。
      // GAP 5.2 fix（2026-08-10，t1 生产实证 tick 83782）：无可见敌人时 target
      // 回退到守家锚点 approachTarget（homeCell/coreGuardFallback），**不再以
      // 自家 Core 格为目标**——旧版 `?? state.core?.position` 让 16+ Vanguard
      // 全体向自家 Core 格前压（Core 格容量 2 被占 → stepBlocked →
      // vanguard_pressure_spread 互堵振荡），守家/打野全停、经济无人测绘。
      const attackPriority = this.effectivePolicy?.attackPriority ?? null;
      let target: Position | null = null;
      if (attackPriority === "workers") {
        const enemyWorker = enemies.find((enemy) => enemy.kind === "UNIT" && enemy.unitType === "WORKER");
        target = enemyWorker?.position ?? nearestEnemy(enemies, unit.position)?.position ?? null;
      } else if (attackPriority === "core") {
        const enemyCore = enemies.find((enemy) => enemy.kind === "CORE");
        target = enemyCore?.position ?? nearestEnemy(enemies, unit.position)?.position ?? null;
      } else {
        target = nearestEnemy(enemies, unit.position)?.position ?? null;
      }
      if (target === null) target = approachTarget;
      // B5 远端突击组局部响应（detachedSquadResponse 候选，竞品对照）：
      // 敌**非目标**战斗单位进入 5 格响应半径 = 突击组被拦截——释放旧任务、
      // 回 Core 守位至少 8 tick（防抖动记忆：8 tick 内敌消失也继续返回）。
      // Core 不迁移（局部冲突不拖 Core 过图）；返回期间邻接敌由函数开头
      // SWEEP 分支反击（反击优先）。8 tick 后任务目标仍在则恢复前压。
      if (this.config.detachedSquadResponse === true) {
        const returnUntil = this.detachedReturnUntil.get(unit.id) ?? 0;
        if (state.tick < returnUntil) {
          const direction = stepToward(unit.position, approachTarget ?? state.core!.position, militaryObstacles);
          if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_detached_return");
          return;
        }
        const intercepted = enemies.some(
          (enemy) =>
            enemy.kind !== "CORE" &&
            (target === null || !samePosition(enemy.position, target)) &&
            manhattan(unit.position, enemy.position) <= DETACHED_RESPONSE_RADIUS,
        );
        if (intercepted && state.core !== null) {
          this.detachedReturnUntil.set(unit.id, state.tick + DETACHED_RETURN_TICKS);
          const direction = stepToward(unit.position, approachTarget ?? state.core.position, militaryObstacles);
          if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_detached_return");
          return;
        }
      }
      if (target !== null && !samePosition(unit.position, target)) {
        const occupancy = occupancyCounts(state);
        const stuckTicks = this.moveFailedStreak.get(unit.id) ?? 0;
        const baseDirection =
          this.config.moveFailedAvoidance === true && stuckTicks >= 2
            ? detourDirection(unit.position, target, militaryObstacles)
            : stepToward(unit.position, target, militaryObstacles);
        let direction = baseDirection;
        let intent = "vanguard_pressure";
        if (direction !== null) {
          // 容量预检（2026-08-10 修复）：第一步落点或目标格总占用（己方+core+
          // 可见敌）≥2（容量 2）→ 硬挤必被引擎拒（CELL_UNIT_LIMIT/
          // MOVE_CONTESTED，t1 生产实证 vanguard_pressure 642+302 次互堵——
          // 全员追同一敌格/核心格挤成一团卡死）→ 改向最近空邻格散开一格
          // （仍朝目标方向推进，不扎堆）；无空邻格 → 原地等本 tick 腾位。
          // occupancyCounts 只计己方+core，敌单位单独补 1（容量 2 下同格敌
          // 最多 2，近似 1 覆盖常见单敌场景；多敌同格属引擎已拒的非法态）。
          const stepCell = move(unit.position, direction);
          const stepOccupancy = occupancy.get(cellKey(stepCell)) ?? 0;
          const stepEnemy = enemies.some((enemy) => samePosition(enemy.position, stepCell));
          const stepTotal = stepOccupancy + (stepEnemy ? 1 : 0);
          const targetOccupancy = occupancy.get(cellKey(target)) ?? 0;
          const targetEnemy = enemies.some((enemy) => samePosition(enemy.position, target));
          const targetTotal = targetOccupancy + (targetEnemy ? 1 : 0);
          const stepBlocked = stepTotal >= 2;
          const targetBlocked = targetTotal >= 2;
          if (stepBlocked || targetBlocked) {
            const spread = nearestFreeAdjacent(unit.position, militaryObstacles, occupancy, enemies);
            if (spread !== null && !samePosition(unit.position, spread)) {
              const spreadDirection = stepToward(unit.position, spread, militaryObstacles);
              if (spreadDirection !== null) {
                direction = spreadDirection;
                intent = "vanguard_pressure_spread";
              }
            }
          }
        }
        if (direction !== null) { set(unit, { type: "MOVE", direction }, intent); return; }
      }
      // GAP 5.2（2026-08-10）：有可见敌人时保持原行为（目标格不可达/已到达 →
      // 原地待命）；无可见敌人时不再无条件 return——单位已到达守家锚点 →
      // fall through 到下方守家/治疗/回防逻辑（heal 轮换、ring_clear、
      // home 锚点），保持完整守家姿态而非钉死在 pressure 分支空转。
      if (enemies.length > 0) return;
    }

    // B8 守卫轮换治疗（guardHealRotation 候选）：defensive 守卫受伤（HP 过半
    // 以下）且无反击压力（敌不在守卫反击射程内）时回 Core 补血——到达后主循环
    // HEAL 分支接管，满血后守位锚点逻辑移出回守位（闭环）。战斗中的守卫不回修：
    // 邻格 SWEEP 反击优先（C7 已覆盖——SWEEP 分支在本函数更早处）。已在 Core
    // 格时不重复 MOVE（HEAL 分支直接治疗）。
    // B8 one-at-a-time（竞品 "one wounded defender at a time"）：同类型守卫
    // 已有回修流程中的（名额占用未过期）→ 本守卫不触发——防多守卫同时离位
    // /同占 Core 格（防线真空）；满血即释放名额。
    // W57 双相 FSM（guardHealRotationTwoPhase）：v1 单相 hold-timer 升级为
    //  patient + relief 两相状态机——claimHealRotationSlot 替代 one-at-a-time
    //  名额检查，advanceHealRotationSlots（decide 入口已调）推进 patient→relief
    //  转换与 relief 冷却到期释放槽。满血释放由 advance 接管（不在此 delete）。
    if (unit.hp > HEAL_ROTATION_HP[unit.unitType] && this.config.guardHealRotationTwoPhase !== true) {
      this.healRotationActive.delete(unit.id);
    }
    if (
      this.config.guardHealRotation === true &&
      this.effectiveAggression === "defensive" &&
      state.core !== null &&
      unit.hp <= HEAL_ROTATION_HP[unit.unitType] &&
      !enemies.some(
        (enemy) =>
          enemy.kind !== "CORE" &&
          chebyshev(unit.position, enemy.position) <= HEAL_ROTATION_ENGAGE_RANGE[unit.unitType],
      ) &&
      !samePosition(unit.position, state.core.position)
    ) {
      const slotClaimed =
        this.config.guardHealRotationTwoPhase === true
          ? this.claimHealRotationSlot(unit, state)
          : !state.vanguards.some(
              (other) =>
                other.id !== unit.id && (this.healRotationActive.get(other.id) ?? 0) > state.tick,
            );
      if (slotClaimed) {
        if (this.config.guardHealRotationTwoPhase !== true) {
          this.healRotationActive.set(unit.id, state.tick + HEAL_ROTATION_HOLD_TICKS);
        }
        const direction = stepToward(unit.position, approachTarget ?? state.core.position, militaryObstacles);
        if (direction !== null) set(unit, { type: "MOVE", direction }, "guard_heal_return");
        return;
      }
    }

    const nearby = enemies.filter((enemy) => manhattan(unit.position, enemy.position) <= 4);
    // clear-path 清障（TS-009 候选）：满载 Worker 回仓路径上的敌人，或站在
    // 我方可见资源格上的敌人（封锁采集），视为挡路者，Vanguard 优先主动清除
    // （覆盖留守）。判据 1：敌人距任一满载 Worker ≤2 格且比 Worker 更靠近 Core
    // （回仓方向）；判据 2：敌人站在可见资源格上（采集封锁——生产实测：被压方
    // 经济 2-4× 差于清场方）。
    if (this.config.clearPath === true && state.core !== null) {
      const corePosition = state.core.position;
      const blockingOnRoute = enemies.find((enemy) =>
        state.workers.some((worker) => {
          if (worker.cargo <= 0) return false;
          if (manhattan(worker.position, enemy.position) > 2) return false;
          const workerDistance = manhattan(worker.position, corePosition);
          const enemyDistance = manhattan(enemy.position, corePosition);
          return enemyDistance < workerDistance;
        }),
      );
      const blockingResource = enemies.find((enemy) => state.resourceCells.has(cellKey(enemy.position)));
      const blockingEnemy = blockingOnRoute ?? blockingResource;
      if (blockingEnemy !== undefined) {
        const direction = stepToward(unit.position, blockingEnemy.position, militaryObstacles);
        if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_clear_path");
        return;
      }
    }
    if (
      nearby.length > 0 &&
      state.core !== null &&
      manhattan(unit.position, state.core.position) <= 4
    ) {
      return;
    }
    // 守家/回防锚点（绝不站 Core 格本身——Core 格是 Worker 回仓通道，被军事
    // 单位长期占用会造成 capacity_wait:DEPOSIT 经济死锁，生产实测）。
    // guardAxes（B4 候选）：有可见敌人时按威胁轴分桶守位（Vanguard 3 格外层
    // 屏、Ranger 2 格内层屏），守卫分散到各威胁轴；无敌人回退历史四邻轮转。
    // W64（terrain-guard 候选）：无可见敌人时按地形背靠重排四邻顺序（守位站
    // 开阔侧、岩石在背后），与 guardAxes 正交（threat vs terrain）。
    let home: Position | null = null;
    if (state.core !== null) {
      home =
        this.config.guardAxes === true && enemies.length > 0
          ? defensePost(state.core.position, enemies, movementObstacles, "VANGUARD", index)
          : this.config.terrainGuard === true
            ? terrainGuardPost(state.core.position, movementObstacles, index)
            : homeCell(state.core.position, movementObstacles, index);
    }
    // 已在 Core 格且满血：移出到让位锚点（yieldAnchor——与 Ranger 同，
    // 避开被占格；t2 实证：Core 四邻全堵时 homeCell 选到满格 → 预裁决
    // 淘汰让位 → 死锁。治疗是短时占格，治疗完必须让出回仓通道）
    if (
      state.core !== null &&
      unit.hp >= UNIT_MAX_HP[unit.unitType] &&
      samePosition(unit.position, state.core.position)
    ) {
      const yieldTarget = yieldAnchor(state.core.position, movementObstacles, occupancyCounts(state), state.visibleEnemies);
      if (yieldTarget !== null && !samePosition(unit.position, yieldTarget)) {
        const direction = stepToward(unit.position, yieldTarget, militaryObstacles);
        if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_home");
        return;
      }
      // 同 Ranger：无合法让位目标原地等，不 fall through 到守位
      return;
    }
    // focusRegion：无敌人时朝策略聚焦区推进（侦察/占位），否则回守家锚点或追击邻近敌人
    const focus = this.effectivePolicy?.focusRegion ?? null;
    const target = nearby.length > 0
      ? nearestEnemy(nearby, unit.position)?.position ?? null
      : focus ?? home;
    if (target !== null && !samePosition(unit.position, target)) {
      const direction = stepToward(unit.position, target, militaryObstacles);
      if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_move");
    }
  }

  private decideRanger(
    state: TickState,
    unit: UnitSnapshot,
    index: number,
    obstacles: ReadonlySet<string>,
    enemies: readonly VisibleEntity[],
    projectedFriendlyDamage: ReadonlyMap<string, number>,
    set: (unit: UnitSnapshot, action: UnitAction, intent: string) => void,
  ): void {
    const movementObstacles = this.world.movementObstacles(unit.id, obstacles);
    // 与 Vanguard 同：军事单位绕开自家 Core 格（生产/SPAWN 通道，见
    // decideVanguard 注释）——让位回归路径不穿越 Core 格。
    const militaryObstacles = state.core === null
      ? movementObstacles
      : new Set([...movementObstacles, cellKey(state.core.position)]);
    // GAP 5.1 fix（2026-08-10）：C7 军事卡死 spread——与 decideVanguard 同。
    if (this.checkMilitaryStuckSpread(unit, state, militaryObstacles, enemies, set)) return;
    // 核心通道清障（core-clearance-v1）：homeCell 四邻全堵时历史行为回退到核心
    // 格（占死卸货通道）——coreClearance 下回退到外圈守位点，军事绝不落核心格。
    const approachTarget = state.core === null
      ? null
      : homeCell(state.core.position, militaryObstacles, index)
        ?? (this.config.coreClearance === true
          ? this.coreGuardFallback(state.core.position, militaryObstacles, index)
          : state.core.position);
    // ring 疏散（与 Vanguard 同，2026-08-08）：核心格被 worker 占用 = 卸货通道占死，
    // cheb-1 Ranger 退到 Chebyshev 2 让位（射击分支优先在上方已处理——有敌就打）。
    const rangerCoreOccupiedByWorker = state.core !== null && state.units.some(
      (u) => u.unitType === "WORKER" && samePosition(u.position, state.core!.position),
    );

    // 核心通道清障（core-clearance-v1，2026-08-07）：本 Ranger 站在核心格上
    // → 疏散到最近空邻格/外圈（与 Vanguard 同，核心格只留给卸货 worker）。
    if (
      this.config.coreClearance === true &&
      state.core !== null &&
      samePosition(unit.position, state.core.position)
    ) {
      const exit = homeCell(state.core.position, movementObstacles, index)
        ?? this.coreGuardFallback(state.core.position, movementObstacles, index);
      if (exit !== null && !samePosition(unit.position, exit)) {
        const direction = stepToward(unit.position, exit, movementObstacles);
        if (direction !== null) { set(unit, { type: "MOVE", direction }, "ranger_clear_core"); return; }
      }
    }

    // 寡不敌众撤退（outnumbered-retreat-v1，2026-08-08，与 Vanguard 同）：非守家
    // Ranger 遇可见敌战斗单位且附近我方军事 < 敌 → 向家撤退（保持射程别被近身）。
    if (this.config.outnumberedRetreat === true && this.outnumbered(state, unit, enemies)) {
      const retreatObstacles = new Set(militaryObstacles);
      for (const enemy of enemies) retreatObstacles.add(cellKey(enemy.position));
      const direction = stepToward(unit.position, state.core!.position, retreatObstacles);
      if (direction !== null) { set(unit, { type: "MOVE", direction }, "ranger_outnumbered_retreat"); return; }
    }

    // 游侠风筝（ranger-kite-v1，2026-08-08，用户导向"打了就跑"）：aggressive Ranger
    // 近身（Chebyshev 1）遇 VANGUARD 近战威胁 → 先退到射程 2-3 可射击格再打，
    // 保射程不被 SWEEP 换血（Ranger HP 2，贴脸两刀就死）；无合法风筝位才原地射击。
    if (this.config.rangerKite === true && this.effectiveAggression === "aggressive") {
      const meleeThreat = enemies.find(
        (enemy) =>
          enemy.kind === "UNIT" &&
          enemy.unitType === "VANGUARD" &&
          chebyshev(unit.position, enemy.position) === 1,
      );
      if (meleeThreat !== undefined) {
        const kite = kiteCell(unit.position, meleeThreat.position, militaryObstacles, occupancyCounts(state), enemies);
        if (kite !== null) {
          const direction = stepToward(unit.position, kite, militaryObstacles);
          if (direction !== null) { set(unit, { type: "MOVE", direction }, "ranger_kite"); return; }
        }
      }
    }

    // Precision shot at a visible enemy in range. Aggressive mode prioritizes
    // enemy Workers to cut their economy (cargo never reaches their Core).
    // Defensive mode prioritizes the nearest threat first (a Vanguard one cell
    // from sweeping us outranks a Worker three cells away), then same value
    // ranks by type (workers first = economy damage), then raw id (determinism).
    const inRange = enemies.filter((enemy) => canShoot(unit.position, enemy.position, obstacles) && !this.shootingLineObscured(unit.position, enemy.position));
    // 协同火力：后决策 Ranger 不再给“本 Tick 已被预计打死”的 Unit 继续补枪。
    // Core 的 shield 未出现在 VisibleEntity，不能仅用 hp 判断致死，因此 Core 始终
    // 保留为合法火力目标。若所有在射程 Unit 都已覆盖，转入下方预测射击/机动。
    const fireable = this.config.coordinatedFire === true
      ? inRange.filter((enemy) => enemy.kind === "CORE" || (projectedFriendlyDamage.get(enemy.id) ?? 0) < enemy.hp)
      : inRange;
    const target = this.effectiveAggression === "aggressive"
      ? fireable.sort(aggressiveShotPriority)[0]
      : fireable.sort((a, b) => defensiveShotPriority(unit.position, a, b))[0];
    // C1 扩展（2026-08-10）：连续 miss 回退。per-ranger SHOT_MISSED 连续
    // 计数（SHOT_HIT 归零）。达上限后跳过直射 AND 预判射击——t1 实证：
    // 旧版只跳过直射，ranger 落入 shoot_cell 继续空枪（predictedEnemyCell
    // 对静止目标总偏移 1 格 → 62% 预判带非零偏移 → 必 miss）。现在达
    // 上限后全部跳过，落入下方走位/重新定位找更好角度。
    const consecutiveMisses = this.rangerConsecutiveMisses.get(unit.id) ?? 0;
    if (target !== undefined) {
      if (consecutiveMisses < RANGER_DIRECT_SHOT_MISS_LIMIT) {
        set(unit, { type: "SHOOT", targetId: target.id, expectedCell: target.position }, "shoot");
        return;
      }
    }

    // Upstream v0.12 cell fire: fire at the predicted next cell of the nearest
    // visible enemy that is out of range. Movement is cardinal-only
    // (UP/DOWN/LEFT/RIGHT), so we predict a single cardinal step along the
    // dominant axis toward us. A unit 4-5 cells away on a straight line can be
    // hit next tick if it keeps advancing toward us; a diagonal enemy's
    // cardinal step lands off the firing line and is filtered out by canShoot
    // (no wasted "shooting air" shots).
    const predictionPool = this.config.coordinatedFire === true
      ? enemies.filter((enemy) => enemy.kind === "CORE" || (projectedFriendlyDamage.get(enemy.id) ?? 0) < enemy.hp)
      : enemies;
    const nearest = nearestEnemy(predictionPool, unit.position);
    if (nearest !== null && consecutiveMisses < RANGER_DIRECT_SHOT_MISS_LIMIT) {
      const predicted = predictedEnemyCell(unit.position, nearest.position);
      // C1 修复（2026-08-10）：预判射击对"确认静止"的敌人跳过——
      // 生产实证 shoot_cell 367 发 → 360 次 SHOT_MISSED（98% 空枪率），
      // 根因是敌方 WORKER 站在资源格上采集不动，预判格永远是空的。
      // 跳过条件（满足任一即不预判开火，落入下方走位接敌）：
      // 1. enemyHints 有记忆且 prevPosition === position → 确认静止
      // 2. 敌人在资源格上（采集 WORKER 不动）→ 高概率静止
      // 首次目击（无 enemyHints 记忆）允许预判——无证据反证其移动。
      const enemyMemory = this.world.enemyHints().find((hint) => hint.id === nearest.id);
      const enemyOnResourceCell = state.resourceCells.has(cellKey(nearest.position));
      const enemyIsStationary = enemyMemory !== undefined
        && enemyMemory.prevPosition !== undefined
        && samePosition(enemyMemory.prevPosition, nearest.position);
      if (
        predicted !== null &&
        !enemyIsStationary &&
        !enemyOnResourceCell &&
        // 预测格必须是敌人"一步可达"的格：障碍格敌人永远走不进去（t1 生产
        // 实测 79857-80001：敌方 WORKER 被障碍列 [-539,-80] 隔开，游侠群
        // 连开 320+ 枪全部 SHOT_MISSED——预判射击只查了弹道中间格，漏查
        // 终点格障碍，且 shoot_cell 提前 return 把游侠钉在原地不走位）。
        !obstacles.has(cellKey(predicted)) &&
        canShoot(unit.position, predicted, obstacles) &&
        !this.shootingLineObscured(unit.position, predicted) &&
        !samePosition(predicted, nearest.position)
      ) {
        set(unit, { type: "SHOOT", targetId: null, expectedCell: predicted }, "shoot_cell");
        return;
      }
    }

    // B12 Ranger 记忆射击（rangerMemoryShot 候选，竞品 strategy.md
    // "A strike Ranger may also fire at the remembered cell of a confirmed
    // stationary Core during a short visibility gap"）：aggressive Ranger
    // 无可见目标时，对"确认静止"（两次观察同位置）的敌 Core 记忆格
    // cell-fire（射程内）——短暂视野丢失不浪费射程压制（Vanguard memory
    // 推进的 Ranger 版：Vanguard 走向记忆，Ranger 打记忆）。
    if (this.config.rangerMemoryShot === true && this.effectiveAggression === "aggressive") {
      // 新鲜度窗口独立收窄（2026-08-10 修复）：记忆射击语义 = 短暂视野丢失
      // 的压制，不继承 strike-core 的 1200 tick 攻坚记忆窗口（死核/迁移核/
      // 重生核残留 → 空枪，t1 生产实证 338 次 SHOT_MISSED）。
      const memoryShotWindow = Math.min(
        this.config.enemyCoreMemoryTicks ?? 60,
        RANGER_MEMORY_SHOT_MAX_AGE,
      );
      const coreMemory = this.world.enemyHints(memoryShotWindow).find(
        (hint) =>
          hint.kind === "CORE" &&
          hint.prevPosition !== undefined &&
          samePosition(hint.prevPosition, hint.position),
      );
      if (
        coreMemory !== undefined &&
        canShoot(unit.position, coreMemory.position, obstacles) &&
        !this.shootingLineObscured(unit.position, coreMemory.position) &&
        // 不打被自己单位占位的格（t1 69640 拆核后实证：死核格上站着己方
        // Vanguard，空放枪观感像打友军 + 浪费 DPS）——占位说明该格当前无敌人。
        !state.units.some((u) => samePosition(u.position, coreMemory.position)) &&
        // C2 修复（2026-08-10）：视野确认缺失 = 该格在友方视野内但无可见
        // 敌核 → 核已迁移/被摧毁/重生到别处 → 记忆格是空的 → 不空枪。
        // 生产实证 338 次 SHOT_MISSED 的根因之一 = 死核/迁移核的旧格记忆
        // 在 60 tick 窗口内持续被打。视野判定用 visionLineBlocked（C4 修复
        // 后与官方 supercover 一致）。
        !this.cellVisibleButNoCore(state, coreMemory.position, obstacles)
      ) {
        set(
          unit,
          { type: "SHOOT", targetId: null, expectedCell: coreMemory.position },
          "ranger_memory_shot",
        );
        return;
      }
    }

    // ring 疏散（core-clearance-v1 补强，2026-08-08，与 Vanguard 同）：核心格被
    // worker 占用 = 卸货通道占死，cheb-1 Ranger 退到 Chebyshev 2 让出核心邻格
    // （守位锚点 homeCell 即 cheb-1，会把自己钉在 ring 上堵死被困空 worker 的
    // 出口）。射击分支在上方已优先（射程内有敌就开火）；仅核心格被占时触发。
    if (
      this.config.coreClearance === true &&
      state.core !== null &&
      rangerCoreOccupiedByWorker &&
      chebyshev(unit.position, state.core.position) === 1 &&
      !samePosition(unit.position, state.core.position)
    ) {
      const post = this.coreGuardFallback(state.core.position, militaryObstacles, index);
      if (
        post !== null &&
        !samePosition(post, state.core.position) &&
        !samePosition(unit.position, post)
      ) {
        const direction = stepToward(unit.position, post, militaryObstacles);
        if (direction !== null) { set(unit, { type: "MOVE", direction }, "ranger_ring_clear"); return; }
      }
    }

    // 远端军事回援（remoteReinforce 候选，竞品 "敌方战斗单位已经进入 Core
    // 防区时，所有非守家单位跳过集结等待并立即回援"）：可见敌方战斗单位进入
    // Core 防区（12 = THREAT_FALLBACK_RADIUS）→ 远端 Ranger 立即回 Core
    // 守位——优先于打野/环搜（家被拆一切白搭）。射击分支在上方已优先（射程
    // 内有敌就开火，不跑路）；回援途中进入射程自然接敌。
    if (this.shouldReinforce(state, unit, enemies)) {
      const direction = stepToward(unit.position, approachTarget ?? state.core!.position, militaryObstacles);
      if (direction !== null) set(unit, { type: "MOVE", direction }, "ranger_reinforce");
      return;
    }

    // 信标夺取（beaconGrab 候选）：无 Vanguard 时才由 Ranger 担任载者（最近者）。
    // 拾取后回 Core 守位持标。射程内射击分支在上方已优先（不放弃火力）。
    const beaconTask = this.beaconMission(state, unit);
    if (beaconTask !== null) {
      const target = beaconTask === "return"
        ? (approachTarget ?? state.core!.position)
        : state.beacon.position;
      const intent = beaconTask === "return" ? "ranger_beacon_return" : "ranger_beacon_fetch";
      if (beaconTask === "return" && state.core !== null && manhattan(unit.position, state.core.position) <= REINFORCE_HOME_RING) {
        set(unit, { type: "WAIT" }, "ranger_beacon_hold");
        return;
      }
      const direction = stepToward(unit.position, target, militaryObstacles);
      if (direction !== null) set(unit, { type: "MOVE", direction }, intent);
      return;
    }

    // B8 守卫轮换治疗（guardHealRotation 候选）：defensive Ranger 受伤且无射程
    // 内敌（射击分支已优先处理——有敌就打，C7 反击优先）时回 Core 补血。
    // 治疗完满血由守位锚点逻辑移出回守位（闭环）。one-at-a-time（竞品
    // "one wounded defender at a time"）：同类型守卫已有回修流程中的 →
    // 本守卫不触发（防多守卫同时离位/同占 Core 格 → 防线真空）。
    // W57 双相 FSM（guardHealRotationTwoPhase）：v1 单相 hold-timer 升级为
    //  patient + relief 两相状态机——claimHealRotationSlot 替代 one-at-a-time
    //  名额检查，advanceHealRotationSlots（decide 入口已调）推进转换与释放。
    if (unit.hp > HEAL_ROTATION_HP[unit.unitType] && this.config.guardHealRotationTwoPhase !== true) {
      this.healRotationActive.delete(unit.id);
    }
    if (
      this.config.guardHealRotation === true &&
      this.effectiveAggression === "defensive" &&
      state.core !== null &&
      unit.hp <= HEAL_ROTATION_HP[unit.unitType] &&
      !enemies.some(
        (enemy) =>
          enemy.kind !== "CORE" &&
          chebyshev(unit.position, enemy.position) <= HEAL_ROTATION_ENGAGE_RANGE[unit.unitType],
      ) &&
      !samePosition(unit.position, state.core.position)
    ) {
      const slotClaimed =
        this.config.guardHealRotationTwoPhase === true
          ? this.claimHealRotationSlot(unit, state)
          : !state.rangers.some(
              (other) =>
                other.id !== unit.id && (this.healRotationActive.get(other.id) ?? 0) > state.tick,
            );
      if (slotClaimed) {
        if (this.config.guardHealRotationTwoPhase !== true) {
          this.healRotationActive.set(unit.id, state.tick + HEAL_ROTATION_HOLD_TICKS);
        }
        const direction = stepToward(unit.position, approachTarget ?? state.core.position, militaryObstacles);
        if (direction !== null) set(unit, { type: "MOVE", direction }, "guard_heal_return");
        return;
      }
    }

    // guardAxes（B4 候选）：defensive + 有可见敌人时 Ranger 守内层屏
    // （2 格）而非追击最近敌（竞品"defenders do not chase beyond the
    // protective posture"——Ranger 冲脸失去射程优势且易被 SWEEP）。
    const guardAxesPost =
      this.config.guardAxes === true &&
      this.effectiveAggression === "defensive" &&
      state.core !== null
        ? defensePost(state.core.position, enemies, movementObstacles, "RANGER", index)
        : null;
    // 守家锚点（绝不站 Core 格本身——Core 格是 Worker 回仓通道，被军事
    // 单位长期占用会造成 capacity_wait:DEPOSIT 经济死锁，生产实测 t2）。
    // guardAxes（B4 候选）有可见敌人时按威胁轴守内层屏（2 格，天然保持
    // Core 邻格为空）；无敌人回退历史四邻轮转。
    // W64（terrain-guard 候选）：无可见敌人时按地形背靠重排四邻顺序
    // （守位站开阔侧、岩石在背后），与 guardAxes 正交（threat vs terrain）。
    // 迁移激活期（migrationMoving，2026-08-09）：统一外环守位——军事编队
    // 贴核心站 4 邻会把移动中的核心围死（生产实证：非守卫军事跟核心走、
    // 核心每格被自己人堵 → 引擎容量拒 → 停滞/REPLAN 循环）。
    const home = state.core === null
      ? null
      : (this.migrationMoving
          ? guardHomeCell(state.core.position, movementObstacles, index, this.migrationPathAhead(state.core.position))
          : null)
        ?? (guardAxesPost
          ?? (this.config.terrainGuard === true
            ? terrainGuardPost(state.core.position, movementObstacles, index)
            : homeCell(state.core.position, movementObstacles, index)));
    // 已在 Core 格且满血：移出到让位锚点（yieldAnchor——优先空邻格、其次
    // 单占用邻格（可挤入，容量 2）；Core 四邻全堵（障碍+单位）时 homeCell
    // 会选到满格 → 预裁决淘汰让位 → Ranger 永不离开 → worker 永不
    // deposit → 经济死锁（t2 实证）。治疗是短时占格，治疗完必须让出）
    if (
      state.core !== null &&
      unit.hp >= UNIT_MAX_HP[unit.unitType] &&
      samePosition(unit.position, state.core.position)
    ) {
      const yieldTarget = yieldAnchor(state.core.position, movementObstacles, occupancyCounts(state), state.visibleEnemies);
      if (yieldTarget !== null && !samePosition(unit.position, yieldTarget)) {
        const direction = stepToward(unit.position, yieldTarget, militaryObstacles);
        if (direction !== null) set(unit, { type: "MOVE", direction }, "ranger_home");
        return;
      }
      // 无合法让位目标（Core 四邻全堵且全满）：原地等下一 tick 重试——
      // 不 fall through 到守位（守位目标可能在 Core 邻格满格 → 预裁决
      // 淘汰 → MOVE_FAILED 循环）。
      return;
    }
    // home-guard-squad-v1 Ranger 守卫（2026-08-09 用户裁决"守卫至少 2 前锋
    // 1 游侠"）：距 Core 最近的 homeGuardRangers 个 Ranger 常驻守家——不参与
    // 攻坚集结/打野/记忆射击（远程守卫的射程优势在 Core 附近最有价值：敌核
    // 拆家队接近时 3 格射程先接敌）。守位锚点独立计算（guard-spacing-v1 外环
    // 站位——共享 home 是 4 邻锚点，贴脸站会堵核心移动/卸货通道）；射击/回援
    // 分支在上方已优先（有敌就开火、家被威胁就回防），这里只拦截"无威胁时的
    // 外出分支"。兵力不足（rangers ≤ 守卫数）时全部守家——家不空防优先。
    if (this.isHomeGuardRanger(state, unit)) {
      // guard-corner-spacing-v1（2026-08-10 用户裁决）：Ranger 守卫同样站
      // 核心四角 3-5 格外环（cornerSpacing=true），2 格内完全让出。
      const guardPost = state.core === null
        ? null
        : guardHomeCell(state.core.position, militaryObstacles, index, this.migrationPathAhead(state.core.position), true);
      if (guardPost !== null && !samePosition(unit.position, guardPost)) {
        const direction = stepToward(unit.position, guardPost, militaryObstacles);
        if (direction !== null) { set(unit, { type: "MOVE", direction }, "ranger_home_guard"); return; }
      }
      set(unit, { type: "WAIT" }, "ranger_home_guard_hold");
      return;
    }
    // 攻坚动量（2026-08-07 t2 jerkman 实证）：aggressive Ranger 无可见敌人时，
    // 若已知敌核心在 64 格有界范围内 → 前压到射程（配合 rangerMemoryShot 对
    // 记忆格射击）——避免"打完遭遇战敌消失 → Ranger 全体回家 → 攻坚脱节"（敌
    // 核心得到喘息重建、我方前两次 Vanguard 战果被浪费）。有界距离防远征
    // （与 Vanguard boundedRaid 同口径）。
    let moveTarget: Position | null;
    if (enemies.length > 0) {
      moveTarget = guardAxesPost ?? nearestEnemy(enemies, unit.position)?.position ?? null;
    } else if (this.effectiveAggression === "aggressive" && state.core !== null) {
      // 兵力门槛（2026-08-07 第二轮 jerkman 攻坚实证）：Ranger 单独前压被
      // 敌方爆兵防线消耗殆尽（5 Ranger 全灭、核心未破）——guide 要求"有护卫
      // 核心先集结、全员到齐再共同出击"。兵力 < attackForce 时守家重建，
      // 达标后 Vanguard+Ranger 成建制压上（与 Vanguard forceGate 同门槛）。
      const military = state.vanguards.length + state.rangers.length;
      // 威胁自适应（2026-08-07）：与 Vanguard forceGate 同口径——高威胁对手
      // 时门槛提高，Ranger 不单薄前压送死。
      const force = this.adaptiveAttackForce();
      const forceGate = force > 0 && military < force;
      // W10 斩首配额（sortie-quota-v1）：开启时 Ranger 编入 sortie 按家防余量
      // 分流不扑同一弱核；未编入 sortie 的 Ranger 不前压弱核（fall through 到
      // focus/scavenge/home）。关闭时历史 .find 行为（零回归）。
      const huntTargets = forceGate
        ? undefined
        : (this.config.weakCoreFirst === true
            ? this.weakCoreOrderedTargets(state)
            : this.world.coreHuntTargets());
      const enemyCoreMemory = huntTargets === undefined
        ? undefined
        : this.config.sortieQuota === true
          ? this.sortieTargetFor(unit, huntTargets, state)
          : huntTargets.find(
              (target) =>
                target.source === "CORE" &&
                chebyshev(state.core!.position, target.position) <= BOUNDED_RAID_DISTANCE,
            );
      // 攻坚集结（rally-assault-v1 Ranger 版，2026-08-08）：Vanguard 先集结但
      // Ranger 单独前压仍会被守军逐个点掉（t2 二轮 jerkman 攻坚实证：5 Ranger
      // 独立前压全灭、核心未破）。Ranger 与 Vanguard 同集结位汇合（同目标同
      // 点位同 rallyReady 状态），组齐/超时后再一起压上——成建制共同出击。
      // **目标源必须与 Vanguard 同（enemyHints 新鲜记忆）**：coreHuntTargets 含
      // survey 跨 run 陈旧播种，会让 Ranger 集结到"没有任何人在进攻"的旧目标
      // （t2 生产实证 72216-72258：ranger_rally 连续 42+ tick，Vanguard 在
      // vanguard_hunt 别处扫荡，rally 永不 ready）。仅新鲜记忆才有集结目标。
      const rallyCore = this.world
        .enemyHints(this.config.enemyCoreMemoryTicks ?? 60)
        .find((hint) => hint.kind === "CORE");
      if (
        this.config.rallyAssault === true &&
        rallyCore !== undefined &&
        chebyshev(state.core.position, rallyCore.position) <= BOUNDED_RAID_DISTANCE &&
        !this.rallyReady(rallyCore.position, cellKey(rallyCore.position), state, unit) &&
        chebyshev(unit.position, rallyCore.position) > RALLY_ATTACK_RADIUS
      ) {
        const point = this.rallyPointForUnit(unit, rallyCore.position, state.core.position, militaryObstacles, state.resourceCells);
        if (!samePosition(unit.position, point)) {
          const direction = stepToward(unit.position, point, militaryObstacles);
          if (direction !== null) set(unit, { type: "MOVE", direction }, "ranger_rally");
          return;
        }
        set(unit, { type: "WAIT" }, "ranger_rally_hold");
        return;
      }
      // 攻坚目标存在 → 成建制前压（enemyCoreMemory 已过 forceGate/集结检查）；
      // 有聚焦区 → 前出到聚焦区；否则 aggressive Ranger 不再回 Core 守位发呆——
      // 游侠打野（ranger-scavenge-v1，2026-08-08，用户导向"游侠出去乱逛、打野、
      // 获取信息、打了就跑"）：沿巡逻环外出测绘 + 敌情 + 寻敌（遇敌由上方射击分支
      // 接管、寡不敌众由 outnumberedRetreat 接管）。
      const focus = this.effectivePolicy?.focusRegion ?? null;
      if (enemyCoreMemory !== undefined) {
        moveTarget = enemyCoreMemory.position;
      } else if (focus !== null) {
        moveTarget = focus;
      } else if (this.config.rangerScavenge === true) {
        this.rangerScavenge(state, unit, index, militaryObstacles, set);
        return;
      } else {
        moveTarget = home;
      }
    } else {
      moveTarget = this.effectivePolicy?.focusRegion ?? home;
    }
    if (moveTarget !== null && !samePosition(unit.position, moveTarget)) {
      // 激进：保持 1-3 射程站定，不冲脸（近身会让 Ranger 失去射程优势且易被
      // SWEEP）。已在射程内但没有合法射击目标（被障碍挡住）时原地待机。
      const distance = manhattan(unit.position, moveTarget);
      const keepRange = this.effectiveAggression === "aggressive" && distance <= 3;
      if (!keepRange) {
        const direction = stepToward(unit.position, moveTarget, militaryObstacles);
        if (direction !== null) set(unit, { type: "MOVE", direction }, "ranger_move");
      } else if (keepRange) {
        // 射程环展开（2026-08-08，t1 生产实证）：Ranger 射程内站定时若本格拥挤
        // （≥2 单位，容量 2 会被继续堆叠），向相邻空位移动——保持火力散开、
        // 各占不同射击格，杜绝"6 Ranger 堆 1 格 + capacity_wait 空转"。
        // 候选仍须满足：非目标格、非障碍、距目标 1-3（保留射程）、空位。
        const occupancy = occupancyCounts(state);
        const here = occupancy.get(cellKey(unit.position)) ?? 0;
        if (here >= 2) {
          for (const delta of RANGER_SPREAD_DELTAS) {
            const cand: Position = [unit.position[0] + delta[0], unit.position[1] + delta[1]];
            if (samePosition(cand, moveTarget)) continue;
            if (militaryObstacles.has(cellKey(cand))) continue;
            if ((occupancy.get(cellKey(cand)) ?? 0) >= 2) continue;
            const cd = manhattan(cand, moveTarget);
            if (cd >= 1 && cd <= 3) {
              const direction = stepToward(unit.position, cand, militaryObstacles);
              if (direction !== null) { set(unit, { type: "MOVE", direction }, "ranger_spread"); return; }
            }
          }
        }
        // 已展开或环上无空位：原地待机（保持射程）
      }
    }
  }

  /** 游侠打野（ranger-scavenge-v1，2026-08-08，用户导向"游侠出去乱逛、打野、获取信息"）：
   *  aggressive Ranger 无可见敌人、无攻坚目标、无聚焦区时沿巡逻环外出（复用
   *  vanguard_scavenge 的环推进机制：16/8 方位 + militaryRingHoldTicks 时间预算
   *  强制升环）——测绘 + 敌情 + 寻敌。遇敌由 decideRanger 上方射击分支接管、
   *  寡不敌众由 outnumberedRetreat 接管，"打了就跑"由 ranger_kite 保射程。
   */
  /** 军事打野方位（military-frontier-scavenge-v1，2026-08-08，对齐 ref "scout routes
   *  prioritize the least recently observed chunks"）：启用时按"当前环探测点所在 chunk
   *  观察老化"选最旧区块优先（offset 分散多单位，避免全员涌向同一最老方位——ref
   *  "avoid sending every scout through the same corridor"）；否则固定 (index*3+7)%N
   *  分散方位（历史行为，零回归）。 */
  private militaryScavengeDirection(
    home: Position,
    beacon: Position,
    ringIndex: number,
    index: number,
    directionCount: number,
  ): number {
    if (this.config.militaryScavengeFrontier === true) {
      return this.world.staleDirection(
        home,
        beacon,
        ringIndex,
        this.config.exploreRadius,
        directionCount,
        (index * 3 + 7) % directionCount,
      );
    }
    return (index * 3 + 7) % directionCount;
  }

  private rangerScavenge(
    state: TickState,
    unit: UnitSnapshot,
    index: number,
    militaryObstacles: ReadonlySet<string>,
    set: (unit: UnitSnapshot, action: UnitAction, intent: string) => void,
  ): void {
    const dense = this.config.militarySearchDense === true;
    const directionCount = dense ? 16 : EXPLORE_DIRECTION_COUNT;
    const home = state.core!.position;
    const beacon = state.beacon.position ?? home;
    // 陈旧区块优先（military-frontier-scavenge-v1，2026-08-08）：同 vanguard_scavenge。
    const memory = this.world.unitMemory(
      unit.id,
      this.militaryScavengeDirection(home, beacon, 0, index, directionCount),
    );
    let patrolRadius = exploreRadiusForRing(this.config.exploreRadius, memory.patrolRing);
    let patrolPoint = dense
      ? exploreTargetDense(home, beacon, memory.patrolDirection, patrolRadius)
      : exploreTarget(home, beacon, memory.patrolDirection, patrolRadius);
    const ringSince = this.unitRingSince.get(unit.id) ?? state.tick;
    const ringHoldExceeded =
      (this.config.militaryRingHoldTicks ?? SCAVENGE_HOLD_TICKS) > 0 &&
      state.tick - ringSince >= (this.config.militaryRingHoldTicks ?? SCAVENGE_HOLD_TICKS);
    if (samePosition(unit.position, patrolPoint) || ringHoldExceeded) {
      this.unitRingSince.set(unit.id, state.tick);
      if (memory.patrolRing < EXPLORE_RING_COUNT - 1) {
        memory.patrolRing += 1;
        patrolRadius = exploreRadiusForRing(this.config.exploreRadius, memory.patrolRing);
        patrolPoint = dense
          ? exploreTargetDense(home, beacon, memory.patrolDirection, patrolRadius)
          : exploreTarget(home, beacon, memory.patrolDirection, patrolRadius);
      } else {
        memory.patrolRing = 0;
        memory.patrolDirection = this.config.militaryScavengeFrontier === true
          ? this.world.staleDirection(
              home, beacon, memory.patrolRing, this.config.exploreRadius, directionCount, (index * 3 + 7) % directionCount,
            )
          : (memory.patrolDirection + 3) % directionCount;
        patrolPoint = dense
          ? exploreTargetDense(home, beacon, memory.patrolDirection, patrolRadius)
          : exploreTarget(home, beacon, memory.patrolDirection, patrolRadius);
      }
    }
    const direction = stepToward(unit.position, patrolPoint, militaryObstacles);
    if (direction !== null) set(unit, { type: "MOVE", direction }, "ranger_scavenge");
    else set(unit, { type: "WAIT" }, "ranger_scavenge_blocked");
  }

  /** 产兵让位预判（spawn-yield-v1，2026-08-08）：核心本 tick 是否计划 SPAWN——
   *  与 decideCore 的 spawn 意图同构但不含副作用（surgeActive 翻转等）：
   *  NORMAL、人口未满、无 heal/repair 优先、非 accumulateTarget 拦截、资源
   *  足够成本+储备。decideWorker 满载分支据此让位（DEPOSIT Phase8 先于
   *  SPAWN Phase10，worker 占核心格会挡 spawn——生产 t2 实证 112 次
   *  CORE_SPAWN_FAILED/CELL_UNIT_LIMIT）。资源不足时不预判 spawn →
   *  worker 正常卸货补充资源（预判与 decideCore 同口径，误差 = 白等 1 tick
   *  卸货，可接受；绝不反向挡 spawn）。 */

  /** W9 beacon-hold 盾上限（持标时 5→10，对齐官方 maxShieldWithBeacon）。
   *  beaconHold 变体未启用 → 恒 5（零回归）；启用且持标（CARRIED + carrier
   *  是我方单位）→ 10。持标判定与 plan-validator / W 源码 _owns_beacon 一致。 */
  private shieldCap(state: TickState): number {
    if (this.config.beaconHold !== true) return 5;
    const beacon = state.beacon;
    if (beacon.status !== "CARRIED" || beacon.carrierId === null) return 5;
    return state.units.some((unit) => unit.id === beacon.carrierId) ? 10 : 5;
  }

  /** C2 修复（2026-08-10）：检查某格是否在友方视野内且无可见敌核——
   *  用于 ranger_memory_shot 视野确认缺失（格在视野内但无核 = 核已迁移/
   *  被摧毁/重生到别处 → 记忆格是空的 → 不空枪）。视野判定与
   *  resourceCellCoveredByVision 同口径：Manhattan 半径 + visionLineBlocked。 */
  private cellVisibleButNoCore(
    state: TickState,
    cell: Position,
    obstacles: ReadonlySet<string>,
  ): boolean {
    const covered = (origin: Position, radius: number): boolean =>
      manhattan(origin, cell) <= radius &&
      !visionLineBlocked(origin, cell, obstacles);
    let anyObserver = false;
    if (state.core !== null && covered(state.core.position, 5)) anyObserver = true;
    if (!anyObserver) {
      for (const unit of state.units) {
        const radius = unit.unitType === "WORKER" ? 3 : unit.unitType === "VANGUARD" ? 4 : 5;
        if (covered(unit.position, radius)) {
          anyObserver = true;
          break;
        }
      }
    }
    if (!anyObserver) return false;
    // 格在视野内 → 检查有无可见敌核在此格
    return !state.visibleEnemies.some(
      (enemy) => enemy.kind === "CORE" && samePosition(enemy.position, cell),
    );
  }

  /** C7 修复（2026-08-10）：军事单位卡死 spread——位置连续 ≥MILITARY_STUCK_TICKS
   *  不变 + 无邻接敌（不在战斗中）→ 强制 spread 到相邻空格，打断 capacity_wait
   *  无限循环。返回 true = 已 spread（调用方 return），false = 未触发（继续正常逻辑）。
   *  复用 nearestFreeAdjacent（vanguard_pressure 互堵修复的同款散开逻辑）。 */
  private checkMilitaryStuckSpread(
    unit: UnitSnapshot,
    state: TickState,
    militaryObstacles: ReadonlySet<string>,
    enemies: readonly VisibleEntity[],
    set: (unit: UnitSnapshot, action: UnitAction, intent: string) => void,
  ): boolean {
    const streak = this.militaryStuckStreak.get(unit.id) ?? 0;
    if (streak < MILITARY_STUCK_TICKS) return false;
    // 战斗中不 spread（邻接敌 = SWEEP/射击优先——卡着也要打）
    const hasAdjacentEnemy = enemies.some(
      (enemy) => chebyshev(unit.position, enemy.position) <= 1,
    );
    if (hasAdjacentEnemy) return false;
    const spread = nearestFreeAdjacent(
      unit.position,
      militaryObstacles,
      occupancyCounts(state),
      enemies,
    );
    if (spread === null || samePosition(unit.position, spread)) return false;
    const direction = stepToward(unit.position, spread, militaryObstacles);
    if (direction === null) return false;
    set(unit, { type: "MOVE", direction }, "military_stuck_spread");
    return true;
  }

  private coreWantsSpawn(state: TickState): boolean {
    const core = state.core;
    if (core === null || core.state !== "NORMAL") return false;
    // C6 修复（2026-08-10）：高水位消费分支在 pop≥ceiling 时仍会 SPAWN——
    // spawnYield 需同步感知此条件，否则满载 worker 不让位 → SPAWN 被
    // 占格挡掉（CELL_UNIT_LIMIT）。resourceHighWater 缺省 0 = 不感知（零回归）。
    const resourceHighWater = this.config.resourceHighWater ?? 0;
    if (resourceHighWater === 0 && state.population >= this.config.populationCeiling) return false;
    if (core.hp < 5) return false; // heal 优先于 spawn
    if (core.shield < this.shieldCap(state) && state.resources >= 1) return false; // repair 优先（W9 beacon-hold 持标盾上限 10）
    if (this.config.accumulateTarget > 0 && state.resources >= this.config.accumulateTarget) {
      return false; // 积累目标拦截，不产兵
    }
    const military = state.vanguards.length + state.rangers.length;
    const threatened =
      this.config.threatMilitaryPriority === true &&
      military < (this.config.threatMilitaryFloor ?? 4) &&
      this.nearbyEnemyCore(state);
    const threshold = this.config.accumulateThreshold ?? 0;
    const surge = threshold > 0 && (this.surgeActive || state.resources >= threshold);
    const unitType = threshold > 0
      ? surge
        ? nextMilitary(state, this.config)
        : threatened
          ? nextMilitary(state, this.config)
          : "WORKER"
      : threatened
        ? nextMilitary(state, this.config)
        : this.config.accumulateTarget > 0 &&
          state.resources >= this.config.guardResources &&
          military < this.config.guardForce
        ? nextMilitary(state, this.config)
        : nextSpawn(state, this.effectiveWorkerTarget, this.config);
    const cost = unitSpawnCost(unitType, state.population);
    const reserve = threatened
      ? this.config.reserveEarly
      : state.resources >= this.config.wealthyThreshold
        ? this.config.reserveWealthy
        : this.config.reserveEarly;
    return state.resources >= cost + reserve;
  }

  private decideCore(state: TickState, intents: Record<string, string>): CoreAction | null {
    const core = state.core;
    if (core === null) return null;
    // Core 迁移（v0.3 PRE_EVADE-lite，coreEvade 配置默认关闭）：迁移中不
    // 生产/heal（竞品语义：MOVING 直接 return）；迁移方向由 START_MOVE 发起
    // 时记录，次 tick 仍 MOVING = 已提交（本地等效 move_progress≥2）。
    if (core.state === "MOVING") {
      // B9 迁移取消候选（coreMigrationCancel，竞品 _moving_core_should_cancel
      // 对照）：目的地为硬块（障碍/资源/敌占）或投影伤害劣于当前格时发
      // CANCEL_MOVE（Core 回 NORMAL）——避免走完 4 tick 后失败或继续走进
      // 敌阵。TickState 的 CoreSnapshot 不带 destination——用迁移方向推断
      // 下一格（近似竞品"目的地"判定；迁移路径上任何一步危险即止损）。
      // 例行 cargo/heal/repair 不取消（竞品同语义）。
      if (this.config.coreMigrationCancel === true && this.coreMoveDirection !== null) {
        const nextCell = move(core.position, this.coreMoveDirection);
        const nextKey = cellKey(nextCell);
        const hardBlocked =
          state.obstacleCells.has(nextKey) ||
          state.resourceCells.has(nextKey) ||
          state.visibleEnemies.some((enemy) => samePosition(enemy.position, nextCell));
        const currentDamage = projectedDamageOnCore(core.position, state.visibleEnemies, state.obstacleCells);
        const nextDamage = projectedDamageOnCore(nextCell, state.visibleEnemies, state.obstacleCells);
        if (hardBlocked || nextDamage > currentDamage) {
          this.coreMigrationCancelUntilTick = state.tick + CORE_MIGRATION_CANCEL_COOLDOWN;
          intents.core = hardBlocked ? "migration_cancel_blocked" : "migration_cancel_danger";
          return { type: "CANCEL_MOVE" };
        }
      }
      // GAP 3.1 fix（2026-08-10）：MOVING 期间允许 HEAL / REPAIR_SHIELD。
      // 竞品语义"例行 heal/repair 不取消迁移"——START_MOVE 是多 tick 自
      // 动推进，期间 Core 的单 tick action 空闲可用于 heal/repair。长距离
      // 迁移（600+ tick）此前完全无防御恢复能力 → Core 被打残也无法修盾
      // /回血。SPAWN 仍需 NORMAL（core.state !== "NORMAL" 拦截），迁移期
      // 不产兵。优先级：CANCEL_MOVE > HEAL > REPAIR_SHIELD > null。
      if (core.hp < 5) {
        intents.core = "core_heal_moving";
        return { type: "HEAL" };
      }
      if (core.shield < this.shieldCap(state) && state.resources >= 1) {
        intents.core = "repair_shield_moving";
        return { type: "REPAIR_SHIELD" };
      }
      return null;
    }
    if (this.config.coreEvade === true) {
      // 触发源（2026-08-07 B1/B3 对齐竞品 threat-response PRE_EVADE）：
      // 1) closing：12 格内可见敌（回退半径）；
      // 2) confirmedPursuit：远距确认追击（积分 ≥3 持续逼近，>12 格也触发）；
      // 3) ttrTrigger：TTR 预撤离（扣 attack-range、observation-gap 缩放）；
      // 4) preemptiveEvadeUntilTick：敌人消失后 2 tick 持续（竞品 2-tick
      //    preemptive_evade_until 对照——防止"敌人闪失 → 立刻取消"抖动）。
      const enemyHints = this.world.enemyHints();
      // 注意：decideCore 的威胁评估**不喂 coreWatch**（入侵观察长 TTL）——否则
      // 敌情记忆会让 Core 因一次短暂目击持续迁移 60 tick 不恢复（core-evade-persist
      // 回归实证：approach 记忆 6 tick 过期后核心应恢复生产）。入侵观察的响应走
      // 军事层（raidUnitDistance 回援 + vanguard_watch_clear 清剿），不动 Core 迁移。
      const threat = assessThreat({
        core: core.position,
        visibleEnemies: state.visibleEnemies,
        enemyHints,
        coreDamagedThisTick: coreDamagedThisTick(state.events),
        obstacles: this.world.obstacles(state.obstacleCells),
        resourceCells: state.resourceCells,
      });
      const closing = threat.closingEnemies > 0;
      const confirmedPursuit = threat.confirmedPursuit;
      let ttrTrigger = false;
      if (this.config.coreEvadeTtr === true) {
        const hintsById = new Map(enemyHints.map((hint) => [hint.id, hint]));
        for (const enemy of state.visibleEnemies) {
          const hint = hintsById.get(enemy.id);
          if (hint?.prevPosition === undefined || hint?.prevSeenTick === undefined) continue;
          const prevDistance = manhattan(hint.prevPosition, core.position);
          const distance = manhattan(enemy.position, core.position);
          const closed = prevDistance - distance; // 观测间隔内总逼近量
          if (closed <= 0) continue;
          const observationGap = hint.lastSeenTick - hint.prevSeenTick; // 间隔 tick
          // 竞品公式：remaining = max(0, d − attack_range)，attack_range =
          // RANGER 3 / VANGUARD 1；ticks_to_attack_range = remaining × gap / closed
          const attackRange = enemy.unitType === "RANGER" ? 3 : 1;
          const remaining = Math.max(0, distance - attackRange);
          if ((remaining * observationGap) / closed <= TTR_PRE_EVADE_TICKS) {
            ttrTrigger = true;
            break;
          }
        }
      }
      // B9（coreEvadePersist 候选，竞品 "approach memory expires" 对照）：
      // closing/TTR 触发后敌人消失时，迁移意图从固定 2 tick 扩展为
      // "approach 记忆未过期"（6 tick 内曾见 12 格内敌——closing 记忆，
      // 仅"曾逼近"才算 approach，远距路过不算）——防"敌人被击退出
      // 12 格 → 2 tick 恢复 → 敌人折返 → 再触发"的迁移抖动（竞品
      // "Preserve migration through short visibility loss"）。
      const approachMemoryActive =
        this.config.coreEvadePersist === true &&
        this.world
          .enemyHints(6)
          .some((hint) => hint.coreDistance !== undefined && hint.coreDistance <= THREAT_RECALL_DISTANCE);
      const preemptivePersist = approachMemoryActive || this.preemptiveEvadeUntilTick >= state.tick;
      const cancelCooldownActive = this.coreMigrationCancelUntilTick >= state.tick;
      if ((closing || confirmedPursuit || ttrTrigger || preemptivePersist) && !cancelCooldownActive) {
        const direction = retreatDirection(
          core.position,
          state.visibleEnemies,
          this.world.obstacles(state.obstacleCells),
          state.beacon.position,
          this.config.coreEvadeScoring === true ? "multi" : "distance",
        );
        if (direction !== null) {
          this.coreMoveDirection = direction;
          // 竞品 preemptive_evade_until_tick = tick + 2：敌人消失后仍持续
          // 2 tick。仅在真实触发时刷新窗口——persist 分支（preemptivePersist
          // 单独为真）不刷新：否则每次 persist 都顺延窗口 = 触发一次
          // closing 后永久迁移、永不恢复生产（2026-08-07 修复，滚动窗口 bug）。
          if (closing || confirmedPursuit || ttrTrigger) {
            this.preemptiveEvadeUntilTick = state.tick + 2;
          }
          intents.core = ttrTrigger ? "core_evade_ttr" : "core_evade";
          return { type: "START_MOVE", direction };
        }
      }
    }
    // W55 单入口掩体寻找（2026-08-09，竞品 `_find_core_shelter` :9388 对照）：
    // aggressive 且无可见敌人时主动抢占单入口掩体（三面岩石口袋）作为 Core
    // 迁移目标——背靠地形防守（仅一方向需布防，raid 难以多轴夹击）。当前
    // Core 位置本身是掩体 = 原地 hold（不迁移、继续产兵/heal）；否则向掩体
    // 入口方向 START_MOVE（逐 tick 推进，与 coreEvade 同走 START_MOVE）。
    // 仲裁优先级：coreEvade（反应式远敌）> coreShelter（主动式抢地形）
    // > cargoBlockedSelfHeal > heal/repair/spawn。仅 NORMAL 非迁移期触发。
    // 与 coreEvade 正交：coreEvade 要求可见敌/追击，coreShelter 要求无可见敌。
    if (
      this.config.coreShelter === true
      && core.state === "NORMAL"
      && this.effectiveAggression === "aggressive"
      && state.visibleEnemies.length === 0
    ) {
      const obstacles = this.world.obstacles(state.obstacleCells);
      // 当前 Core 位置已是掩体 → 原地 hold（继续产兵/heal，不白迁移）。
      if (isCoreShelter(core.position, obstacles) === null) {
        const radius = this.config.coreShelterSearchRadius ?? CORE_SHELTER_DEFAULT_RADIUS;
        const shelter = coreShelterTarget(core.position, obstacles, state.resourceCells, radius);
        if (shelter !== null) {
          // 向掩体入口方向走 1 格（stepToward BFS 首步；入口是口袋的唯一开放
          // 邻格——走到入口下 tick 即可再决策进入掩体）。
          const direction = stepToward(core.position, shelter.entrance, obstacles);
          if (direction !== null) {
            this.coreMoveDirection = direction;
            intents.core = "core_shelter_seek";
            return { type: "START_MOVE", direction };
          }
        }
      }
    }
    // cargo-rescue-v1（W6，2026-08-09，cargoBlockedSelfHeal）：cargo 被堵检测
    // （多个满载 worker 长时间 cargo 不变 + Core 未移动）→ Core 向最近满载
    // worker 靠拢 1 格（reference `cargo_blocked` :9934 + `CORE_MIGRATION_ENABLED
    // or cargo_blocked` :9946-9953，决策原因 core migrate reason=cargo_blocked_self_heal）。
    // liveness 恢复对 cargo worker 无效（worker 已满载、无采集目标可清、无方向可
    // rotate → 6 tick 无限循环），Core 主动靠拢打开卸货通道是唯一出路。
    // 仲裁优先级：coreEvade > cargoBlockedSelfHeal > heal/repair/spawn
    // （coreEvade 已 return；靠拢仅 NORMAL 非迁移期；与迁移 conductor 隔离）。
    // 冷却 cargoBlockedSelfHealCooldownTicks（默认 30）避免每 tick 都迁移
    // （迁移中不产兵 = 经济停滞）；靠拢路径被堵超时撤退 cargoBlockedSelfHealStallTicks
    // （默认 10，超时放弃靠拢）。
    if (this.config.cargoRescue === true && core.state === "NORMAL") {
      const cooldownTicks = this.config.cargoBlockedSelfHealCooldownTicks ?? CARGO_RESCUE_COOLDOWN_TICKS;
      const stallTicks = this.config.cargoBlockedSelfHealStallTicks ?? CARGO_RESCUE_STALL_TICKS;
      const stallCargoTicks = this.config.cargoBlockedSelfHealStallCargoTicks ?? CARGO_RESCUE_STALL_CARGO_TICKS;
      const minWorkers = this.config.cargoBlockedSelfHealMinWorkers ?? CARGO_RESCUE_MIN_WORKERS;
      // 靠拢进行中超时检测：靠拢开始后 stallTicks 仍未到目标 → 放弃（恢复产兵）
      if (this.cargoSelfHealTargetId !== null && this.cargoSelfHealStartedTick > 0) {
        if (state.tick - this.cargoSelfHealStartedTick >= (this.cargoSelfHealStallTicks ?? stallTicks)) {
          // 超时撤退：清状态，进入冷却
          this.cargoSelfHealTargetId = null;
          this.cargoSelfHealStartedTick = 0;
          this.cargoSelfHealStallTicks = null;
          this.cargoSelfHealUntilTick = state.tick + cooldownTicks;
        }
      }
      // 冷却内不触发
      if (state.tick >= this.cargoSelfHealUntilTick) {
        // 检测被堵满载 worker：cargo > 0 且 stuckSince 距今 ≥ stallCargoTicks
        const stuckCargoWorkers = state.workers.filter((worker) => {
          if (worker.cargo <= 0) return false;
          const since = this.cargoStuckSince.get(worker.id);
          return since !== undefined && state.tick - since >= stallCargoTicks;
        });
        if (stuckCargoWorkers.length >= minWorkers) {
          // 选最近满载 worker 作为靠拢目标（确定性：距离升序 + id tie-break）
          const target = stuckCargoWorkers
            .slice()
            .sort(
              (a, b) =>
                manhattan(a.position, core.position) - manhattan(b.position, core.position) ||
                a.id.localeCompare(b.id),
            )[0]!;
          // 2026-08-10 Core 迁移自愈 3 守卫（waaiging _choose_core_migration 参考）：
          // 守卫 1 距离门槛：target 距 Core ≤6 不迁移（近距离 worker 靠
          //   near_core_deposit 锁 + 排队 hold 解决，Core 迁移帮不上反打断交仓）。
          // 守卫 3 logistics_hold：8 格内有"未打转"（不在 stuck 名单）的满载
          //   worker → Core 不动（防靠拢打断正在交仓的近程 worker）。
          // 守卫 2 远距离参数：距离 >12 用长 stall(60)+短 cooldown(8)——原 10/30
          //   让 Core 每 40 tick 移 1 格，26 格需 1040 tick 永不到达。远距离
          //   stall 超时检测用实例字段 cargoSelfHealStallTicks（下 tick 超时检测读它）。
          const targetDistance = manhattan(target.position, core.position);
          // GAP 5.4 fix（2026-08-10，t1 生产实证 tick 83922）：超过
          // CARGO_RESCUE_MAX_DISTANCE（20）的满载 worker 是"归途中的采集者"
          // （cargo 在返航途中天然不变），不是卸货被堵——Core 追它只会无限
          // 迁移（t1 实证：worker 平均距核 39，核心每 8 tick 追 1 格连续
          // 30+ tick，经济冻结）。超过上限不触发 rescue，等 worker 自己回来。
          if (targetDistance <= CARGO_RESCUE_MIN_DISTANCE) {
            // 近距离不迁移：fall through 到 heal/repair/spawn
          } else if (targetDistance <= CARGO_RESCUE_MAX_DISTANCE) {
            const progressingNearby = state.workers.some(
              (w) =>
                w.cargo > 0 &&
                manhattan(w.position, core.position) <= CARGO_RESCUE_LOGISTICS_HOLD_RADIUS &&
                !this.cargoStuckSince.has(w.id),
            );
            if (!progressingNearby) {
              // 靠拢方向：向目标 worker 走 1 格（stepToward 走 BFS 最近路径首步）
              const approachDirection = stepToward(
                core.position,
                target.position,
                this.world.obstacles(state.obstacleCells),
              );
              if (approachDirection !== null) {
                // 守卫 2：远距离参数（>12 用长 stall + 短 cooldown）
                const isFarRange = targetDistance > CARGO_RESCUE_FAR_RANGE_THRESHOLD;
                const effectiveStallTicks = isFarRange
                  ? CARGO_RESCUE_FAR_STALL_TICKS
                  : stallTicks;
                const effectiveCooldownTicks = isFarRange
                  ? CARGO_RESCUE_FAR_COOLDOWN_TICKS
                  : cooldownTicks;
                this.coreMoveDirection = approachDirection;
                this.cargoSelfHealTargetId = target.id;
                this.cargoSelfHealStartedTick = state.tick;
                this.cargoSelfHealUntilTick = state.tick + effectiveCooldownTicks;
                this.cargoSelfHealStallTicks = effectiveStallTicks;
                intents.core = "cargo_blocked_self_heal";
                return { type: "START_MOVE", direction: approachDirection };
              }
            }
          }
        }
      }
    }
    if (core.hp < 5) {
      intents.core = "core_heal";
      return { type: "HEAL" };
    }
    if (core.shield < this.shieldCap(state) && state.resources >= 1 && core.state === "NORMAL") {
      intents.core = "repair_shield";
      return { type: "REPAIR_SHIELD" };
    }
    if (core.state !== "NORMAL" || state.population >= this.config.populationCeiling) return null;
    if (this.config.accumulateTarget > 0 && state.resources >= this.config.accumulateTarget) {
      intents.core = "accumulated_target";
      return null;
    }

    // O3 核格占用检查（2026-08-10，算法优化）：核心格已有单位占位时
    // SPAWN 会 CELL_UNIT_LIMIT（容量 2 = core + 1 unit = 满；加 SPAWN = 3 >
    // 容量 2 = 失败）。deterministic-planner.selectDeterministicCoreAction
    // 已有此检查（C6 修复），safety 侧 decideCore 作为 fallback/sim 路径
    // 需同步——防 fallback 模式下 SPAWN 白发失败。spawnYield 机制让 worker
    // 下一 tick 让位后重试；HEAL/REPAIR_SHIELD 在此之前已 return，不受影响。
    const occupantsOnCore = state.units.filter(
      (unit) => unit.position[0] === core.position[0] && unit.position[1] === core.position[1],
    ).length;
    if (occupantsOnCore > 0) {
      intents.core = "spawn_blocked_occupancy";
      return null;
    }

    const military = state.vanguards.length + state.rangers.length;
    // 威胁优先产兵（2026-08-08，military-priority-v1）：活跃敌核贴脸
    // （raid-defense nearbyEnemyCore ≤24 格）且军事未达地板 → 跳过 worker
    // 积累直接产兵（reference guide"敌方进入 Core 防区 → 守家队优先补齐"）。
    // 默认关闭零回归；t3 实证 3 活跃敌核 ≤20 格仅 1 Vanguard。
    const threatened =
      this.config.threatMilitaryPriority === true &&
      military < (this.config.threatMilitaryFloor ?? 4) &&
      this.nearbyEnemyCore(state);
    // 三阶段爆兵状态机（2026-08-06 用户导向"积累到一定程度开始爆兵"）：
    // 1. 积累期（surgeActive=false 且 res < 阈值）：只产 Worker 积累经济；
    // 2. 爆兵期（surgeActive=true）：持续全力产兵（交替 VANGUARD/RANGER，
    //    不受 militaryRatio 限制，人口上限内）——达标即激活并保持，直到
    //    资源连一个兵都产不起才回积累期（防止"产 1 兵掉回阈值下"振荡）；
    // 3. 前压期：军事规模达 attackForce 后由 decideVanguard 前压打水晶。
    // accumulateThreshold 缺省 0 = 关闭（历史行为：按 militaryRatio 随产随造）。
    const threshold = this.config.accumulateThreshold ?? 0;
    if (threshold > 0 && !this.surgeActive && state.resources >= threshold) {
      this.surgeActive = true;
    }
    const unitType = threshold > 0
      ? this.surgeActive
        ? nextMilitary(state, this.config)
        : threatened
          ? nextMilitary(state, this.config)
          : "WORKER"
      : threatened
        ? nextMilitary(state, this.config)
        : this.config.accumulateTarget > 0 &&
          state.resources >= this.config.guardResources &&
          military < this.config.guardForce
        ? nextMilitary(state, this.config)
        : nextSpawn(state, this.effectiveWorkerTarget, this.config);
    // militaryRatio 接线（W52 GA 前置，2026-08-09）：militaryRatioEnabled 开关
    // 默认关——历史 nextSpawn/nextMilitary 的 V/R 选择逻辑完整保留（零回归）。
    // 开启后：workers 已达 effectiveWorkerTarget 且 policy.militaryRatio > 0
    // 时，按 militaryRatio 决定 VANGUARD vs RANGER（augment 而非替换——是否
    // 产兵/产 Worker 仍由上面的历史门控决定，仅 V/R 选择读 policy）。ratio
    // 接近 1 多 Vanguard、接近 0 多 Ranger、0.5 交替（与 nextMilitary 的
    // vanguardRatio 同 ceil((military+1)*ratio) 公式）。GA 搜出来的 MacroPolicy
    // 5 维参数在生产 SafetyPlanner 此前 0 维生效——本接线让第 5 维 militaryRatio
    // 进入生产消费。
    const policyMilitaryRatio = this.effectivePolicy?.militaryRatio ?? 0;
    const militaryRatioActive =
      this.config.militaryRatioEnabled === true &&
      state.workers.length >= this.effectiveWorkerTarget &&
      policyMilitaryRatio > 0;
    const spawnType: UnitType = militaryRatioActive && unitType !== "WORKER"
      ? this.chooseMilitaryByRatio(state, policyMilitaryRatio)
      : unitType;
    const cost = unitSpawnCost(spawnType, state.population);
    const reserve = threatened
      ? this.config.reserveEarly
      : state.resources >= this.config.wealthyThreshold
        ? this.config.reserveWealthy
        : this.config.reserveEarly;
    if (state.resources < cost + reserve) {
      if (threshold > 0 && this.surgeActive) this.surgeActive = false;
      return null;
    }
    intents.core = `spawn_${spawnType.toLowerCase()}`;
    return { type: "SPAWN", unitType: spawnType };
  }

  /**
   * militaryRatio 驱动的 VANGUARD vs RANGER 选择（W52 GA 前置，2026-08-09）。
   * 与 nextMilitary 的 vanguardRatio 分支同公式：targetVanguards =
   * ceil((military+1)*ratio)——新兵计入后 VANGUARD 占比不超过 ratio 才产
   * VANGUARD，否则产 RANGER。ratio=1 全 Vanguard、0 全 Ranger、0.5 交替。
   * 纯函数（无副作用），便于 GA 仿真与单测复用。
   */
  private chooseMilitaryByRatio(state: TickState, ratio: number): "VANGUARD" | "RANGER" {
    const militaryCount = state.vanguards.length + state.rangers.length;
    const targetVanguards = Math.ceil((militaryCount + 1) * ratio);
    return state.vanguards.length < targetVanguards ? "VANGUARD" : "RANGER";
  }
}






