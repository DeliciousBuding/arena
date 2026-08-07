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
  lineBlocked,
  manhattan,
  move,
  nearest,
  stepToward,
} from "../domain/nav.ts";
import { UNIT_MAX_HP } from "../domain/plan-validator.ts";
import { countEnemiesNearCore } from "../domain/plan-validator.ts";
import { PhaseMachine } from "../domain/phase-machine.ts";
import { type CoreHuntTarget, World } from "../domain/world.ts";
import {
  assessThreat,
  coreDamagedThisTick,
  projectedDamageOnCore,
  type ThreatAssessment,
} from "../domain/threat.ts";
import { RAID_CORE_RADIUS, RAID_SIGHTING_FRESH_TICKS, RAID_UNIT_WATCH_RADIUS } from "../domain/raid-risk.ts";
import { aggressionOf, type MacroPolicy } from "../runtime/macro-policy.ts";
import {
  DEFAULT_SAFETY_CONFIG,
  type AggressionLevel,
  type SafetyPlannerConfig,
  type ThreatProfile,
  type ThreatTier,
} from "./safety-planner-config.ts";
import {
  aggressiveShotPriority,
  canShoot,
  defensePost,
  defensiveShotPriority,
  homeCell,
  nearestEnemy,
  nextMilitary,
  nextSpawn,
  occupancyCounts,
  parseCell,
  predictedEnemyCell,
  retreatDirection,
  samePosition,
  yieldAnchor,
} from "./safety-planner-helpers.ts";

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
/** Core 迁移 TTR 预撤离阈值（竞品 time-to-range ≤16 tick）。 */
const TTR_PRE_EVADE_TICKS = 16;
/** B9 迁移取消冷却（coreMigrationCancel）：取消后 N tick 内不重触发 START_MOVE。 */
const CORE_MIGRATION_CANCEL_COOLDOWN = 10;
/** 守卫轮换治疗（B8 候选）：HP ≤ 该值即回 Core 补血（掉血过半）。 */
const HEAL_ROTATION_HP: Record<UnitType, number> = { WORKER: 1, VANGUARD: 2, RANGER: 1 };
/** 守卫"战斗中不回修"的反击范围（敌进入守卫反击射程 = 战斗压力，带伤值守）。 */
const HEAL_ROTATION_ENGAGE_RANGE: Record<UnitType, number> = { WORKER: 1, VANGUARD: 1, RANGER: 3 };
/** B8 守卫轮换 one-at-a-time（竞品 "one wounded defender at a time"）：
 *  触发回修后该守卫占用回修名额的 tick 窗口（路上 + 补血）。 */
const HEAL_ROTATION_HOLD_TICKS = 12;
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
/** 军事打野沿环扫描时间预算：同一八分点目标 >N tick 未到达强制换向（防障碍点卡死）。 */
const SCAVENGE_HOLD_TICKS = 24;
/** 敌情狩猎清扫半径（Chebyshev）：进入该范围视为"到达基地"，开始扇形清扫。 */
const HUNT_SWEEP_RADIUS = 4;
/** 敌情狩猎清扫时长：单位在基地清扫圈内停留该 tick 数仍未发现敌 Core → 记
 *  清扫并旋转到下一目标（竞品 "整个区域被视野覆盖且未发现 Core 才删除"）。 */
const HUNT_SWEEP_TICKS = 8;
/** B10 worker 遭遇撤离（竞品 Scout And Observer Response）：撤离触发半径。 */
const SCOUT_EVADE_RADIUS = 3;
/** 到 Core 3 格内后的冷却 tick（竞品 three-Tick cooldown）。 */
const SCOUT_COOLDOWN_TICKS = 3;
/** 到达即进入冷却的 Core 距离（竞品 within three cells）。 */
const SCOUT_HOME_RADIUS = 3;

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

export class SafetyPlanner {
  readonly world: World;
  readonly phase: PhaseMachine;
  private configValue: SafetyPlannerConfig;
  /** 当前 SafetyPlanner 配置（热加载 2026-08-08：updateConfig 原子替换引用，
   *  World/巡逻记忆不丢；所有决策路径经 this.config 实时读取）。 */
  get config(): SafetyPlannerConfig {
    return this.configValue;
  }
  /** 热加载配置快照（tick 间调用；非法配置由调用方先校验，这里只做引用替换）。 */
  updateConfig(config: SafetyPlannerConfig): void {
    this.configValue = config;
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
  /** 本 tick 威胁评估（threatBreakout 用）：decide 入口计算一次供 worker 消费。 */
  private currentThreat: ThreatAssessment | null = null;
  /** B5 突击组被拦截后的返回截止 tick（unitId → tick；8-tick 防抖动记忆）。 */
  private detachedReturnUntil = new Map<string, number>();
  /** 远端军事回援状态（unitId → 回援截止 tick；remoteReinforce 候选）。 */
  private reinforceUntil = new Map<string, number>();
  /** 军事打野沿环扫描状态（unitId → 当前环已扫八分点数 + 上次到达 tick）：
   *  2026-08-07 攻坚发现修复——旧版"单点到达即进环"在 8 方位点之间留缝，
   *  敌 Core 恰在缝里（t1 敌 Core 距 Core ~15 格、角度 -62°，NE/NW 环线差 8 格）
   *  → 军事永不出视野接敌。改沿环扫描（到达八分点后 direction+1 扫圆周，
   *  扫满 8 点进下一环）+ 时间预算（同一目标 >SCAVENGE_HOLD_TICKS 未到达强制换向）。 */
  private scavengeSweep = new Map<string, { ring: number; reached: number; lastReach: number }>();
  /** 敌情狩猎清扫状态（2026-08-07）：huntArriveAt = 单位进入某基地清扫圈的起始
   *  tick（unitId → {key, tick}）；huntSweptAt = 基地已清扫 tick（key → tick，
   *  目标 lastSeenTick > sweptAt 视为"清扫后重新发现"，恢复狩猎）。 */
  private readonly huntArriveAt = new Map<string, { key: string; tick: number }>();
  private readonly huntSweptAt = new Map<string, number>();
  /** B10 worker 遭遇撤离状态（unitId → 返回截止/冷却截止 tick）。 */
  private scoutEvadeState = new Map<string, { returnUntil: number; cooldownUntil: number }>();
  /** B8 守卫轮换 one-at-a-time：回修流程中的守卫（unitId → 名额占用截止 tick）。 */
  private healRotationActive = new Map<string, number>();
  /** C2 RECOVERY：上次见到的我方 Core id（全新 UUID = 重生/替换 → 清战场记忆）。 */
  private lastCoreId: string | null = null;
  /** C2 RECOVERY 触发次数（telemetry/测试可读）。 */
  coreRecoveryCount = 0;
  /** C2 RECOVERY 事件日志（telemetry/测试可读；正常对局为空）。 */
  readonly recoveryLog: string[] = [];

  /** 官方排行榜威胁画像（username → tier，2026-08-07）：由 tenant-runtime 从
   *  data/leaderboard/ 快照加载注入；缺省空 Map = 无威胁情报（零回归）。
   *  可变 Map（seedThreatProfiles 装配用），消费端只读。 */
  private readonly threatProfiles = new Map<string, ThreatProfile>();

  constructor(
    config: SafetyPlannerConfig = DEFAULT_SAFETY_CONFIG,
    world = new World(),
    threatProfiles: ReadonlyMap<string, ThreatProfile> = new Map(),
  ) {
    this.configValue = config;
    this.world = world;
    this.phase = new PhaseMachine(config.phase);
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

  /** 启动播种（持久敌情测绘，2026-08-07）：从历史 calibration cases 提取的最后
   *  已知敌 Core 位置注入 World——重启后军事仍记得敌方基地（解决"重启→记忆
   *  清零→军队空转"）。返回实际播种数。 */
  seedCoreHuntTargets(targets: readonly CoreHuntTarget[]): number {
    return this.world.seedCoreHuntTargets(targets);
  }

  /** 注入官方排行榜威胁画像（2026-08-07，deterministic-planner 装配用）：
   *  覆盖式设置——构造后由装配点传入；空 Map 清空画像（零回归）。 */
  seedThreatProfiles(profiles: ReadonlyMap<string, ThreatProfile>): void {
    for (const [username, profile] of profiles) {
      this.threatProfiles.set(username, profile);
    }
  }

  /** 敌情狩猎扫掠点：远距离（>清扫圈）直接朝基地中心；近距离按单位序号绕基地
   *  圆周展开（DENSE_DELTAS × 2，16 方位）——小队扇形覆盖清扫，防所有单位挤
   *  同格/同向（竞品彻查时"优先选择新增覆盖最多、相互视野重叠最少的目标"）。 */
  private huntSweepPoint(target: Position, index: number, reach: number): Position {
    if (reach > HUNT_SWEEP_RADIUS) return target;
    const [dx, dy] = DENSE_DELTAS[(index * 3 + 7) % DENSE_DELTAS.length]!;
    return [target[0] + dx * 2, target[1] + dy * 2];
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
    const designee = vanguardPool[0] ?? rangerPool[0];
    if (designee === undefined || designee.u.id !== unit.id) return null;
    return "fetch";
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
      const designee = vanguardPool[0] ?? rangerPool[0];
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
    this.phase.update({
      population: state.population,
      resources: state.resources,
      enemyNearCore: countEnemiesNearCore(state, this.config.threatEnemyDistance),
    });
    // 威胁评估（threatBreakout 用）：decide 入口算一次（有 Core 且有可见敌时）。
    this.currentThreat = null;
    if (state.core !== null && state.visibleEnemies.length > 0) {
      this.currentThreat = assessThreat({
        core: state.core.position,
        visibleEnemies: state.visibleEnemies,
        enemyHints: this.world.enemyHints(),
        coreDamagedThisTick: coreDamagedThisTick(state.events),
        obstacles: this.world.obstacles(state.obstacleCells),
        resourceCells: state.resourceCells,
      });
    }
    // MOVE_FAILED 反馈（moveFailedAvoidance）：上 tick 结算拒绝的单位计连续失败，
    // 其余清零——连续失败 ≥2 时单位改走垂直绕行格探路（见 detourDirection）。
    if (this.config.moveFailedAvoidance === true) {
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

    const actions: Record<string, UnitAction> = {};
    const intents: Record<string, string> = {};
    const obstacles = this.world.obstacles(new Set([
      ...state.obstacleCells,
      ...(input.sharedObstacles ?? []),
    ]));
    const allies = input.allyUsernames ?? new Set<string>();
    const enemies = state.visibleEnemies
      .filter((enemy) => !(enemy.kind === "CORE" && enemy.ownerUsername !== undefined && allies.has(enemy.ownerUsername)))
      .sort((a, b) => a.id.localeCompare(b.id));
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

    const set = (unit: UnitSnapshot, action: UnitAction, intent: string): void => {
      actions[unit.id] = action;
      intents[unit.id] = intent;
    };

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
        this.decideRanger(state, unit, rangerIndex.get(unit.id) ?? 0, obstacles, enemies, set);
      }
    }

    const coreAction = this.decideCore(state, intents);
    return { tick: state.tick, unitActions: actions, coreAction, intents };
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
    const movementObstacles = this.world.movementObstacles(unit.id, obstacles);
    // 威胁召回（threatRecall，v0.3 实验）：12 格内可见敌（确认接触）时 worker
    // 巡逻/探索半径缩到守家圈（RECALL_PATROL_RADIUS），不放远探/远采。
    // BREAKOUT 全面收缩（threatBreakout，v0.3 实验）：多轴包围（无逃逸方向）
    // 时同样缩家——被包围时外出即送死，等包围解除再恢复。
    const recallActive =
      this.config.threatRecall === true &&
      (state.visibleEnemies.some(
        (enemy) => home !== null && manhattan(enemy.position, home) <= THREAT_RECALL_DISTANCE,
      ) ||
        // 快攻防御（raid-defense-v1，2026-08-07）：警戒半径放宽到 18——小股
        // 部队更早进入防区即召回 worker 缩家圈（不等贴脸）。
        (this.config.raidDefense === true &&
          home !== null &&
          this.raidUnitDistance(state) <= (this.config.raidWatchRadius ?? RAID_UNIT_WATCH_RADIUS)));
    const breakoutActive =
      this.config.threatBreakout === true && this.currentThreat?.level === "BREAKOUT";
    const maxPatrolRadius =
      recallActive || breakoutActive ? RECALL_PATROL_RADIUS : Number.POSITIVE_INFINITY;

    if (unit.cargo > 0) {
      // 核心迁移中交仓待命（core-moving-hold-v1，2026-08-07）：MOVING 期间
      // 引擎拒绝 DEPOSIT（CORE_MOVING/CORE_NOT_PRESENT——生产实测 t2/t3 手操
      // 迁移时 150 tick 内 17/11 次失败），cargo worker 原地持货等核心稳定，
      // 不追着移动核心空跑；核心回 NORMAL 后恢复正常交仓。
      if (
        this.config.coreMovingHold === true &&
        state.core?.state === "MOVING"
      ) {
        set(unit, { type: "WAIT" }, "worker_hold_cargo_moving");
        return;
      }
      if (home !== null && samePosition(unit.position, home)) {
        if (state.resourceSpace > 0) set(unit, { type: "DEPOSIT" }, "deposit");
        else if (this.config.coreClearance === true) {
          // 核心满/迁移中卸不了 → 离开核心格待命，不堵通道（guide 竞品
          // "Core 满仓分散待命并腾空生产格" 对齐——满载 worker 占核心格会
          // 挡 SPAWN/后续卸货）。
          const exit = homeCell(home, movementObstacles, index)
            ?? this.coreGuardFallback(home, movementObstacles, index);
          if (exit !== null && !samePosition(unit.position, exit)) {
            const direction = stepToward(unit.position, exit, movementObstacles);
            if (direction !== null) { set(unit, { type: "MOVE", direction }, "worker_clear_core"); return; }
          }
        }
      } else if (home !== null) {
        const stuckTicks = this.moveFailedStreak.get(unit.id) ?? 0;
        const direction =
          this.config.moveFailedAvoidance === true && stuckTicks >= 2
            ? detourDirection(unit.position, home, movementObstacles)
            : stepToward(unit.position, home, movementObstacles);
        if (direction !== null) set(unit, { type: "MOVE", direction }, "return_home");
      }
      return;
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

    // B13 worker 空闲回血（idleHealReturn 候选，竞品 heal priority 对照）：
    // 空 worker（无 cargo/资源任务/撤离）HP 未满且 Core 资源足够补满时回
    // Core 补血——在 Core 上由主循环 HEAL 分支结算；治疗成本 1 HP=1 资源，
    // 资源不足不返航（竞品"远处单位保持原有空闲任务"）。优先级低于撤离/
    // 回仓（见上），高于采集与巡逻。
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
      // 召回期间只采守家圈内的矿（远矿等威胁解除再采）
      if (recallActive && target !== null && home !== null && manhattan(target, home) > maxPatrolRadius) {
        memory.workerMode = "patrol";
        memory.harvestTarget = null;
      } else {
        memory.workerMode = "go_harvest";
        memory.harvestTarget = target;
        if (target !== null && !samePosition(target, unit.position)) {
          const stuckTicks = this.moveFailedStreak.get(unit.id) ?? 0;
          const direction =
            this.config.moveFailedAvoidance === true && stuckTicks >= 2
              ? detourDirection(unit.position, target, movementObstacles)
              : stepToward(unit.position, target, movementObstacles);
          if (direction !== null) set(unit, { type: "MOVE", direction }, "go_harvest");
        }
      }
      return;
    }

    const hints = this.world.resourceHints();
    if (
      memory.workerMode === "go_harvest" &&
      memory.harvestTarget !== null &&
      hints.some((hint) => samePosition(hint, memory.harvestTarget!))
    ) {
      const inRecallRange = home === null || manhattan(memory.harvestTarget, home) <= maxPatrolRadius;
      if (inRecallRange) {
        const direction = stepToward(unit.position, memory.harvestTarget, movementObstacles);
        if (direction !== null) set(unit, { type: "MOVE", direction }, "go_harvest_mem");
      }
      return;
    }

    // 记忆矿主动开采（harvest-memory-mine-v1，2026-08-08，survey-db 联动）：
    // 无可见资源且无活跃目标时，从已知矿记忆（含跨 run 测绘 seed）挑最近的
    // 去挖——修复"矿发现了但永远不被主动去挖"（生产实证：worker 只在可见时
    // 采，巡逻错过已知矿后永不回头）。距离上限防追 70+ 格远矿（t4 实证）。
    if (this.config.harvestMemoryMine === true && memory.harvestTarget === null) {
      const maxDist = this.config.harvestMemoryMaxDist ?? HARVEST_MEMORY_MAX_DIST;
      let best: Position | null = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const hint of hints) {
        const d = manhattan(unit.position, hint);
        if (d <= maxDist && (home === null || manhattan(hint, home) <= maxPatrolRadius) && d < bestDist) {
          best = hint;
          bestDist = d;
        }
      }
      if (best !== null) {
        memory.workerMode = "go_harvest";
        memory.harvestTarget = best;
        if (!samePosition(unit.position, best)) {
          const direction = stepToward(unit.position, best, movementObstacles);
          if (direction !== null) set(unit, { type: "MOVE", direction }, "go_harvest_mem");
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
      let patrolRadius = exploreRadiusForRing(this.config.exploreRadius, memory.patrolRing);
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
        if (memory.patrolRing < EXPLORE_RING_COUNT - 1) {
          memory.patrolRing += 1;
          patrolRadius = exploreRadiusForRing(this.config.exploreRadius, memory.patrolRing);
          patrolPoint = this.workerPatrolPoint(home, beacon, memory.patrolDirection, patrolRadius);
          target = patrolPoint;
        } else {
          memory.patrolReturning = true;
          target = home;
        }
      } else if (samePosition(unit.position, home)) {
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
        patrolRadius = exploreRadiusForRing(this.config.exploreRadius, memory.patrolRing);
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
          patrolRadius = exploreRadiusForRing(this.config.exploreRadius, memory.patrolRing);
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
      const direction = stepToward(unit.position, target, movementObstacles);
      if (direction !== null) set(unit, { type: "MOVE", direction }, "patrol");
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
    // 核心通道清障（core-clearance-v1）：homeCell 四邻全堵时历史行为回退到核心
    // 格（占死卸货通道）——coreClearance 下回退到外圈守位点，军事绝不落核心格。
    const approachTarget = state.core === null
      ? null
      : homeCell(state.core.position, militaryObstacles, index)
        ?? (this.config.coreClearance === true
          ? this.coreGuardFallback(state.core.position, militaryObstacles, index)
          : state.core.position);
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

    if (this.effectiveAggression === "aggressive") {
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
      const reserveGuards = this.adaptiveReserveGuards(state);
      const sortedVanguards = [...state.vanguards].map((v) => v.id).sort();
      const reserveGuard =
        reserveGuards > 0 &&
        sortedVanguards.length > reserveGuards &&
        sortedVanguards.slice(-reserveGuards).includes(unit.id);
      if (reserveGuard) {
        const home = state.core === null
          ? null
          : homeCell(state.core.position, militaryObstacles, index)
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
      if (enemies.length === 0 && state.resourceCells.size === 0 && state.core !== null) {
        // 敌情狩猎（militaryHunt，2026-08-07 持久敌情测绘）：优先回访最后已知
        // 敌基地（CORE 目击 sticky + Worker 轨迹推断锚点），而不是从自家 Core
        // 盲目环搜。清扫语义：进入清扫圈停留 HUNT_SWEEP_TICKS 仍未发现敌 Core
        // → 记清扫旋转下一目标；目标被重新目击（lastSeenTick 更新）→ 恢复狩猎。
        if (this.config.militaryHunt === true) {
          const hunt = this.world.coreHuntTargets();
          const target = hunt.find((t) => {
            const sweptAt = this.huntSweptAt.get(cellKey(t.position));
            return sweptAt === undefined || t.lastSeenTick > sweptAt;
          });
          if (target !== undefined) {
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
        }
        const dense = this.config.militarySearchDense === true;
        const directionCount = dense ? 16 : EXPLORE_DIRECTION_COUNT;
        const memory = this.world.unitMemory(unit.id, (index * 3 + 7) % directionCount);
        const home = state.core.position;
        const beacon = state.beacon.position ?? home;
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
          (this.config.militaryRingHoldTicks ?? 0) > 0 &&
          state.tick - ringSince >= (this.config.militaryRingHoldTicks ?? 0);
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
            memory.patrolDirection = (memory.patrolDirection + 3) % directionCount;
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
      const attackPriority = this.effectivePolicy?.attackPriority ?? null;
      let target: Position | null = null;
      if (attackPriority === "workers") {
        const enemyWorker = enemies.find((enemy) => enemy.kind === "UNIT" && enemy.unitType === "WORKER");
        target = enemyWorker?.position ?? nearestEnemy(enemies, unit.position)?.position ?? state.core?.position ?? null;
      } else if (attackPriority === "core") {
        const enemyCore = enemies.find((enemy) => enemy.kind === "CORE");
        target = enemyCore?.position ?? nearestEnemy(enemies, unit.position)?.position ?? state.core?.position ?? null;
      } else {
        target = nearestEnemy(enemies, unit.position)?.position ?? state.core?.position ?? null;
      }
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
        const stuckTicks = this.moveFailedStreak.get(unit.id) ?? 0;
        const direction =
          this.config.moveFailedAvoidance === true && stuckTicks >= 2
            ? detourDirection(unit.position, target, militaryObstacles)
            : stepToward(unit.position, target, militaryObstacles);
        if (direction !== null) set(unit, { type: "MOVE", direction }, "vanguard_pressure");
      }
      return;
    }

    // B8 守卫轮换治疗（guardHealRotation 候选）：defensive 守卫受伤（HP 过半
    // 以下）且无反击压力（敌不在守卫反击射程内）时回 Core 补血——到达后主循环
    // HEAL 分支接管，满血后守位锚点逻辑移出回守位（闭环）。战斗中的守卫不回修：
    // 邻格 SWEEP 反击优先（C7 已覆盖——SWEEP 分支在本函数更早处）。已在 Core
    // 格时不重复 MOVE（HEAL 分支直接治疗）。
    // B8 one-at-a-time（竞品 "one wounded defender at a time"）：同类型守卫
    // 已有回修流程中的（名额占用未过期）→ 本守卫不触发——防多守卫同时离位
    // /同占 Core 格（防线真空）；满血即释放名额。
    if (unit.hp > HEAL_ROTATION_HP[unit.unitType]) {
      this.healRotationActive.delete(unit.id);
    }
    if (
      this.config.guardHealRotation === true &&
      this.effectiveAggression === "defensive" &&
      state.core !== null &&
      unit.hp <= HEAL_ROTATION_HP[unit.unitType] &&
      !state.vanguards.some(
        (other) =>
          other.id !== unit.id && (this.healRotationActive.get(other.id) ?? 0) > state.tick,
      ) &&
      !enemies.some(
        (enemy) =>
          enemy.kind !== "CORE" &&
          chebyshev(unit.position, enemy.position) <= HEAL_ROTATION_ENGAGE_RANGE[unit.unitType],
      ) &&
      !samePosition(unit.position, state.core.position)
    ) {
      this.healRotationActive.set(unit.id, state.tick + HEAL_ROTATION_HOLD_TICKS);
      const direction = stepToward(unit.position, approachTarget ?? state.core.position, militaryObstacles);
      if (direction !== null) set(unit, { type: "MOVE", direction }, "guard_heal_return");
      return;
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
    let home: Position | null = null;
    if (state.core !== null) {
      home =
        this.config.guardAxes === true && enemies.length > 0
          ? defensePost(state.core.position, enemies, movementObstacles, "VANGUARD", index)
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
    set: (unit: UnitSnapshot, action: UnitAction, intent: string) => void,
  ): void {
    const movementObstacles = this.world.movementObstacles(unit.id, obstacles);
    // 与 Vanguard 同：军事单位绕开自家 Core 格（生产/SPAWN 通道，见
    // decideVanguard 注释）——让位回归路径不穿越 Core 格。
    const militaryObstacles = state.core === null
      ? movementObstacles
      : new Set([...movementObstacles, cellKey(state.core.position)]);
    // 核心通道清障（core-clearance-v1）：homeCell 四邻全堵时历史行为回退到核心
    // 格（占死卸货通道）——coreClearance 下回退到外圈守位点，军事绝不落核心格。
    const approachTarget = state.core === null
      ? null
      : homeCell(state.core.position, militaryObstacles, index)
        ?? (this.config.coreClearance === true
          ? this.coreGuardFallback(state.core.position, militaryObstacles, index)
          : state.core.position);

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

    // Precision shot at a visible enemy in range. Aggressive mode prioritizes
    // enemy Workers to cut their economy (cargo never reaches their Core).
    // Defensive mode prioritizes the nearest threat first (a Vanguard one cell
    // from sweeping us outranks a Worker three cells away), then same value
    // ranks by type (workers first = economy damage), then raw id (determinism).
    const inRange = enemies.filter((enemy) => canShoot(unit.position, enemy.position, obstacles));
    const target = this.effectiveAggression === "aggressive"
      ? inRange.sort(aggressiveShotPriority)[0]
      : inRange.sort((a, b) => defensiveShotPriority(unit.position, a, b))[0];
    if (target !== undefined) {
      set(unit, { type: "SHOOT", targetId: target.id, expectedCell: target.position }, "shoot");
      return;
    }

    // Upstream v0.12 cell fire: fire at the predicted next cell of the nearest
    // visible enemy that is out of range. A unit in range 4-5 can be hit next
    // tick if it keeps advancing toward us along the same line.
    const nearest = nearestEnemy(enemies, unit.position);
    if (nearest !== null) {
      const predicted = predictedEnemyCell(unit.position, nearest.position);
      if (
        predicted !== null &&
        canShoot(unit.position, predicted, obstacles) &&
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
      const coreMemory = this.world.enemyHints(this.config.enemyCoreMemoryTicks ?? 60).find(
        (hint) =>
          hint.kind === "CORE" &&
          hint.prevPosition !== undefined &&
          samePosition(hint.prevPosition, hint.position),
      );
      if (coreMemory !== undefined && canShoot(unit.position, coreMemory.position, obstacles)) {
        set(
          unit,
          { type: "SHOOT", targetId: null, expectedCell: coreMemory.position },
          "ranger_memory_shot",
        );
        return;
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
    if (unit.hp > HEAL_ROTATION_HP[unit.unitType]) {
      this.healRotationActive.delete(unit.id);
    }
    if (
      this.config.guardHealRotation === true &&
      this.effectiveAggression === "defensive" &&
      state.core !== null &&
      unit.hp <= HEAL_ROTATION_HP[unit.unitType] &&
      !state.rangers.some(
        (other) =>
          other.id !== unit.id && (this.healRotationActive.get(other.id) ?? 0) > state.tick,
      ) &&
      !enemies.some(
        (enemy) =>
          enemy.kind !== "CORE" &&
          chebyshev(unit.position, enemy.position) <= HEAL_ROTATION_ENGAGE_RANGE[unit.unitType],
      ) &&
      !samePosition(unit.position, state.core.position)
    ) {
      this.healRotationActive.set(unit.id, state.tick + HEAL_ROTATION_HOLD_TICKS);
      const direction = stepToward(unit.position, approachTarget ?? state.core.position, militaryObstacles);
      if (direction !== null) set(unit, { type: "MOVE", direction }, "guard_heal_return");
      return;
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
    const home = state.core === null
      ? null
      : guardAxesPost ?? homeCell(state.core.position, movementObstacles, index);
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
      const enemyCoreMemory = forceGate
        ? undefined
        : this.world.coreHuntTargets().find(
            (target) =>
              target.source === "CORE" &&
              chebyshev(state.core!.position, target.position) <= BOUNDED_RAID_DISTANCE,
          );
      moveTarget = enemyCoreMemory?.position ?? this.effectivePolicy?.focusRegion ?? home;
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
      }
    }
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
    if (core.hp < 5) {
      intents.core = "core_heal";
      return { type: "HEAL" };
    }
    if (core.shield < 5 && state.resources >= 1 && core.state === "NORMAL") {
      intents.core = "repair_shield";
      return { type: "REPAIR_SHIELD" };
    }
    if (core.state !== "NORMAL" || state.population >= this.config.populationCeiling) return null;
    if (this.config.accumulateTarget > 0 && state.resources >= this.config.accumulateTarget) {
      intents.core = "accumulated_target";
      return null;
    }

    const military = state.vanguards.length + state.rangers.length;
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
        : "WORKER"
      : this.config.accumulateTarget > 0 &&
          state.resources >= this.config.guardResources &&
          military < this.config.guardForce
        ? nextMilitary(state, this.config)
        : nextSpawn(state, this.effectiveWorkerTarget, this.config);
    const cost = unitType === "WORKER" ? 5 : unitType === "VANGUARD" ? 10 : 12;
    const reserve = state.resources >= this.config.wealthyThreshold
      ? this.config.reserveWealthy
      : this.config.reserveEarly;
    if (state.resources < cost + reserve) {
      if (threshold > 0 && this.surgeActive) this.surgeActive = false;
      return null;
    }
    intents.core = `spawn_${unitType.toLowerCase()}`;
    return { type: "SPAWN", unitType };
  }
}






