import { cellKey, parseCellKey, type Position, type TickState, type UnitType, type VisibleEntity } from "./model.ts";
import { chebyshev, exploreRadiusForRing, exploreTarget, lineBlocked, manhattan } from "./nav.ts";

export type ResourceState = "visible" | "stale" | "harvested";
export type WorkerMode = "patrol" | "go_harvest";

const TRANSIENT_MOVE_FAILURE_REASONS = new Set([
  "MOVE_CONTESTED",
  "MOVE_SWAP_BLOCKED",
  "MOVE_DESTINATION_OCCUPIED",
  "CELL_UNIT_LIMIT",
]);

/** 资源记忆 TTL：stale/harvested 超过 64 ticks（≈4 个 refill 周期）删除，
 *  防"幽灵资源"——记忆中的资源格实际已被采空/不再 refill。 */
const RESOURCE_MEMORY_TTL_TICKS = 64;

/** 核心迁移巡逻重置阈值（Chebyshev）：核心稳定（NORMAL）位置变化 ≥ 5 格视为
 *  迁移——worker 的 patrolRing/patrolDirection 基于旧 Core 坐标系，迁移后
 *  继续沿旧方位扫旧区域（t2 生产实证：核心东迁 14 格后 worker 聚集旧区域
 *  x-44..-49、可见资源 0、全 WAIT 经济冻结）。核心 NORMAL 且位移 ≥ 阈值 →
 *  重置 worker 巡逻记忆，让 worker 从新核心重新组织。 */
const CORE_PATROL_RESET_THRESHOLD = 5;
/** 信标位置历史长度上限（beaconGrab 防追标）：10 tick 窗口内 2+ 个不同位置 =
 *  信标在移动（敌方携带/漂移），窗口 20 足够判定且不拖内存。 */
const BEACON_HISTORY_MAX = 20;

/** 敌情狩猎（2026-08-07，持久敌情测绘）：CORE 目击目标 sticky 窗口
 *  （≈2000 tick ≈ 敌 Core 残血回满/迁移周期——回访最后已知基地仍有效）。 */
const CORE_HUNT_STICKY_TICKS = 2000;
/** 敌情狩猎：WORKER_INFER（轨迹/单次目击推断）目标记忆窗口——推断会漂移，短于 CORE。 */
const CORE_HUNT_WORKER_INFER_TICKS = 400;
/** 敌情狩猎：敌 Worker 轨迹反推基地的方向延伸距离（格）。 */
const CORE_HUNT_INFER_EXTEND = 8;
/** 敌情狩猎：敌 Worker 单次目击（无轨迹）时"远离最近我方单位"的猜测距离（格）。 */
const CORE_HUNT_SINGLE_EXTEND = 8;
/** 敌战斗单位归属敌 Core 的最大距离（assault-overmatch-v1，Chebyshev）：
 *  可见 Vanguard/Ranger 距某已知敌 Core ≤ 该值 = 该基地守军（v3.0
 *  ASSAULT_CORE_FORCE_RADIUS=16 放宽到 30——记忆目标可能滞后于实际位置，
 *  单位在视野边缘游走仍应计入守军）。 */
const ENEMY_CORE_ASSIGN_RADIUS = 30;
/** 敌情狩猎：单次目击猜测的 8 方位候选（与巡逻探索同构，覆盖全向）。 */
const HUNT_AWAY_DELTAS: readonly (readonly [number, number])[] = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];

/** 地图分块尺寸（frontier 探索）：16×16 格 chunk——巡逻环 8..40、
 *  视野 5，chunk 过大（32）环内 8 方位常落同块无区分，过小（8）碎片化噪声。
 *  chunk 记忆驱动"未观察分区优先"（frontier-v1：观察最老的分区先巡）。 */
const CHUNK_SIZE = 16;

/** 官方视野半径（rules-v0.11/v0.14 钉定，sim/contracts 核对）：
 *  WORKER 3 / VANGUARD 4 / RANGER 5 / CORE 5。 */
export const VISION_RADIUS: Readonly<Record<UnitType | "CORE", number>> = {
  WORKER: 3,
  VANGUARD: 4,
  RANGER: 5,
  CORE: 5,
};

/** 视野遮挡判定：integer supercover 线（与官方 SDK sim/visibility/supercoverLine
 *  及 arena-hero-agent _has_vision_line 同构）。途经格（不含 origin，含 target）
 *  任一为障碍 → 遮挡；target 自身不算遮挡（目标格是资源/单位，非障碍）。
 *  C4 修复（2026-08-10）：对角过角（nextX===nextY）时官方 supercover 推两个
 *  角侧格 [x+sx,y] + [x,y+sy]，任一为障碍即遮挡——旧实现只查对角格漏查
 *  角侧，导致"说可见但实际被角侧障碍挡住"的误判（216 处 brute-force 不一致）。 */
export function visionLineBlocked(
  origin: Position,
  target: Position,
  obstacles: ReadonlySet<string>,
): boolean {
  const dx = target[0] - origin[0];
  const dy = target[1] - origin[1];
  const nx = Math.abs(dx);
  const ny = Math.abs(dy);
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  let x = origin[0];
  let y = origin[1];
  let ix = 0;
  let iy = 0;
  while (ix < nx || iy < ny) {
    // Cell-center → cell-center 穿越：比较下一个半格边界交叉时刻（纯整数，
    // 无浮点）。nextX==nextY 时对角过角，先推 x 再推 y，两角侧格都算。
    const nextX = (2 * ix + 1) * ny;
    const nextY = (2 * iy + 1) * nx;
    if (nextX < nextY) {
      x += sx;
      ix += 1;
    } else if (nextX > nextY) {
      y += sy;
      iy += 1;
    } else {
      // C4 修复：对角过角时，官方 supercover 先推两个角侧格再推对角格。
      // 角侧格是途经格（非 target），障碍遮挡视线。
      if (obstacles.has(cellKey([x + sx, y]))) return true;
      if (obstacles.has(cellKey([x, y + sy]))) return true;
      x += sx;
      y += sy;
      ix += 1;
      iy += 1;
    }
    if (ix === nx && iy === ny) break; // 到达 target，自身不算遮挡
    if (obstacles.has(cellKey([x, y]))) return true;
  }
  return false;
}

/** 视线感知资源失效（ref arena-hero-agent v0.2.0 CHANGELOG：
 *  "Vision-aware resource invalidation ... integer supercover lines"）：
 *  格子被任意我方观察者"确认可见"（Manhattan 半径内 + supercover 视线无遮挡）
 *  则返回 true。障碍遮挡不算确认——可能只是躲在障碍后面看不见，资源未必消失。 */
function resourceCellCoveredByVision(
  state: TickState,
  cell: Position,
  obstacleMemory: ReadonlySet<string>,
): boolean {
  const covered = (origin: Position, radius: number): boolean =>
    manhattan(origin, cell) <= radius && !visionLineBlocked(origin, cell, obstacleMemory);
  if (state.core !== null && covered(state.core.position, VISION_RADIUS.CORE)) return true;
  for (const unit of state.units) {
    if (covered(unit.position, VISION_RADIUS[unit.unitType])) return true;
  }
  return false;
}

/** chunk 坐标支持负坐标（t1 Core [-619,-154]）：floor 除法而非截断。 */
export function chunkKeyFor(position: Position): string {
  const cx = Math.floor(position[0] / CHUNK_SIZE);
  const cy = Math.floor(position[1] / CHUNK_SIZE);
  return `${cx},${cy}`;
}

export interface ResourceMemory {
  readonly cell: Position;
  state: ResourceState;
  readonly firstSeenTick: number;
  lastSeenTick: number;
  /** 跨 run 测绘种子（survey-db seed）：stale 时不受 hints 新鲜度窗口限制，
   *  直到被真实观察/采集/确认耗尽自然刷新——否则 seed lastSeenTick=0 会被
   *  maxAge 窗口滤掉（tick 68000 - 0 > 32），seed 永不提示。 */
  seeded?: boolean;
}

/** 资源任务候选（生产回流 99b4ba2，resourceCandidates 单一事实源）：可见 +
 * 合法 stale/seeded 记忆，携带新鲜度/seed 元数据供全局任务分配器做置信代价
 * （visible=false 时按 age 惩罚、seeded 额外惩罚、超 40 格边界不入池）。
 * 返回复制快照，调用方不能修改 World 内部记忆。 */
export interface ResourceCandidate {
  readonly cell: Position;
  readonly state: "visible" | "stale";
  readonly firstSeenTick: number;
  readonly lastSeenTick: number;
  readonly seeded: boolean;
}

export interface EnemyMemory {
  readonly id: string;
  position: Position;
  /** 上一可见 tick 的位置（威胁评估 ALERT 信号：位置差分 → 敌移动检测，
   *  2026-08-06 竞品 hierarchical threat assessment 对照）。 */
  prevPosition?: Position;
  /** 上一可见 tick（观测间隔 = lastSeenTick - prevSeenTick；竞品
   *  observation-gap 缩放——敌人间歇可见时逼近速度按间隔折算，
   *  2026-08-07 B1 TTR 公式对齐）。 */
  prevSeenTick?: number;
  /** 上一可见 tick 时敌距 Core 的 Chebyshev 距离（距离差分 pursuit score 的
   *  分母——竞品对照：closed = prev.d - cur.d，>0 逼近 +2、==0 平行 +1、
   *  <0 远离 -1，位置未动强制 0——天然滤除"路过"误报）。 */
  coreDistance?: number;
  /** 追击积分 [0,4]（cap 4）：>0 且（d≤12 或 score≥3）= 确认追击。 */
  pursuitScore: number;
  kind: "UNIT" | "CORE";
  unitType?: UnitType;
  lastSeenTick: number;
}

/** 敌情狩猎目标（2026-08-07，持久敌情测绘）：敌 Core 基地候选——发现即长期
 *  保留，即使短 TTL 战术记忆过期，部队仍会回访最后已知基地清扫（竞品
 *  "old Core coordinate 标为待确认并按区域彻查"）。来源：
 *  - CORE：直接目击敌 Core（最高置信，sticky）；
 *  - WORKER_INFER：由敌 Worker 轨迹/单次目击推断的基地候选（较短窗口）。 */
/** 近核入侵观察半径（Chebyshev，2026-08-08）：敌单位进入该距离即入"近核观察"
 *  ——与 raidWatchRadius（Manhattan 18）同量级威胁边界，保证侦察/回援/清剿
 *  共享同一"家边敌情"口径。 */
export const CORE_WATCH_RADIUS = 18;
/** 近核入侵观察记忆 TTL（tick）：近核敌情短暂失明不失忆——短 TTL 战术记忆
 *  （enemyHints 6 / stationary 12）会漏掉"盘踞/间歇可见"的近核敌情（t2 实证：
 *  敌 WORKER 在离核心 2 格处盘踞 600+ tick，记忆过期后威胁归零）。60 tick ≈
 *  1 分钟窗口，足够触发威胁 ALERT + 回援 + Vanguard 回访清剿。 */
export const CORE_WATCH_TTL = 60;

/** 近核入侵观察记忆（2026-08-08）：距我方 Core ≤ CORE_WATCH_RADIUS 的敌单位
 *  长 TTL 记忆。静止标记 = 连续两次目击同格（盘踞 camp / 挂机单位，白赚目标）；
 *  coreDistance 为目击时距 Core 的 Chebyshev 快照（Core 迁移后旧观察自然失效，
 *  新目击重建）。供威胁 ALERT（战斗单位）与 Vanguard 回访清剿消费。 */
export interface CoreWatchMemory {
  readonly id: string;
  position: Position;
  kind: "UNIT" | "CORE";
  unitType?: UnitType;
  /** 连续两次目击同位置 = 静止（盘踞 camp / 挂机单位）。 */
  stationary: boolean;
  /** 最近一次目击时距 Core 的 Chebyshev 距离（快照，不随 Core 迁移漂移）。 */
  coreDistance: number;
  lastSeenTick: number;
}

export interface CoreHuntTarget {
  readonly position: Position;
  readonly lastSeenTick: number;
  readonly source: "CORE" | "WORKER_INFER";
  /** 敌方 Core 所有者用户名（2026-08-07，排行榜威胁画像接入）：enemy-intel
   *  播种时从 calibration 提取；用于把官方排行榜"猛攻蛆"威胁等级映射到
   *  攻坚目标——高威胁对手留强防守。缺省 null/undefined = 未知所有者。 */
  readonly owner?: string | null;
  /** 敌方 Core 实体 id（2026-08-08，旧核验证协议）：用于同 id 迁移去重——
   *  核心移动后旧位置条目被新位置替换，杜绝"地图上两个同款核心"幽灵。
   *  缺省 null/undefined = 未知/播种条目（不参与去重）。 */
  readonly ownerId?: string | null;
}

/** 敌 Core 兵力记忆（2026-08-07，assault-overmatch-v1）：可见敌战斗单位
 *  (Vanguard/Ranger) 按最近已知敌 Core 分配——按 Core 估计守军兵力，供攻坚
 *  "严格占优"决策（存活兵力 > 守军估计才压上；守军增援则提高门槛/蓄势）。
 *  与 coreHuntMemory 同 key（cellKey of Core position）。单位按 ID 去重。 */
export interface EnemyCoreForce {
  readonly position: Position;
  readonly vanguards: ReadonlySet<string>;
  readonly rangers: ReadonlySet<string>;
  readonly lastSeenTick: number;
  /** cellKey(敌 Core 位置)（与 coreHuntMemory 同 key）。 */
  readonly key: string;
}

export interface UnitMemory {
  workerMode: WorkerMode;
  harvestTarget: Position | null;
  patrolDirection: number;
  patrolRing: number;
  patrolStarted: boolean;
  patrolReturning: boolean;
  lastTick: number;
}

export interface WorldSnapshot {
  readonly tick: number;
  readonly obstacles: readonly string[];
  readonly resources: readonly {
    cell: string;
    state: ResourceState;
    firstSeenTick: number;
    lastSeenTick: number;
  }[];
  readonly enemies: readonly {
    id: string;
    cell: string;
    kind: "UNIT" | "CORE";
    lastSeenTick: number;
  }[];
  readonly unitModes: Readonly<Record<string, WorkerMode>>;
  /** 敌情狩猎目标（快照/测绘：指挥面板可渲染敌方基地候选）。 */
  readonly coreHuntTargets: readonly {
    position: Position;
    source: "CORE" | "WORKER_INFER";
    lastSeenTick: number;
    owner?: string | null;
  }[];
}

export interface WorldOptions {
  /** 视线感知资源失效（2026-08-08，ref arena-hero-agent v0.2.0）：被视野
   *  确认可见却不在本轮 resourceCells 的资源格 → 立即记 harvested 负记忆。
   *  默认开启；关闭退回纯 stale 降级（A/B 对照/热加载预留）。 */
  readonly visionInvalidation?: boolean;
}

export class World {
  private readonly visionInvalidation: boolean;

  constructor(options: WorldOptions = {}) {
    this.visionInvalidation = options.visionInvalidation ?? true;
  }

  private tick = 0;
  private readonly obstacleMemory = new Set<string>();
  /** 格级"已观测且确认为空地"集合（fog-of-war shooting gate，2026-08-10）。
   *  obstacleMemory 只记障碍，不记空地——agent 无法区分"已观测空"和"未观测
   *  迷雾"，lineBlocked 对后者当作空地 → 射击线中间格在迷雾中可能是障碍
   *  → SHOT_MISSED。surveyedEmpty 记所有进入过友方视野且不在障碍列表的格，
   *  使 isCellObserved 能区分三态（障碍/已观测空/未观测迷雾）。 */
  private readonly surveyedEmpty = new Set<string>();
  private readonly resourceMemory = new Map<string, ResourceMemory>();
  private readonly enemyMemory = new Map<string, EnemyMemory>();
  /** 近核入侵观察（2026-08-08，core-threat-watch-v1）。 */
  private readonly coreWatch = new Map<string, CoreWatchMemory>();
  private readonly failedCells = new Map<string, number>();
  /** 分级冷却（2026-08-08，缺席实证）：cellKey → 失败冷却 tick 数覆盖（缺席
   *  统计高频格升级冷却，见 seedFailedCooldownTiers）。无记录 = 走默认冷却。 */
  private readonly extendedFailedCooldowns = new Map<string, number>();
  /** GAP 1.3（渐进冷却升级，2026-08-10）：运行时反复失败的资源格计数器。
   *  markResourceFailed 每次累加，达阈值（3→96/6→192/10→384）升级
   *  extendedFailedCooldowns。矿刷新（visible）时在 observe 中重置。防
   *  32-tick 周期振荡——worker 反复被派到同一死矿格，每次只冷 32 tick
   *  过后又试，永不升级。 */
  private readonly resourceFailCounts = new Map<string, number>();
  private readonly unitMoveFailures = new Map<string, Map<string, number>>();
  private readonly unitMemories = new Map<string, UnitMemory>();
  /** chunk 观察记忆（frontier 探索）：chunkKey → 最近一次观察 tick。
   *  观察来源 = 视野实体格（障碍/资源/敌人/我方单位/Core/Beacon）——
   *  巡逻/采集到达的区域随实体观察自然更新老化。 */
  private readonly chunkMemory = new Map<string, number>();
  /** 信标位置历史（beaconGrab 防追标）：近 N tick 的 beacon.position 序列——
   *  移动中的信标 = 被敌方核心携带/漂移（t2 生产实证：信标被 jerkman 核心
   *  带着东移），单骑追标会深入敌区送死；静止（真掉落）才可 fetch。 */
  private readonly beaconHistory: { tick: number; position: Position }[] = [];
  /** 敌情狩猎记忆（sticky）：敌 Core 基地候选（绝对坐标——C2 RECOVERY 不清，
   *  属战略 intel 而非相对 Core 的战场记忆）。 */
  private readonly coreHuntMemory = new Map<string, CoreHuntTarget>();
  /** 旧核验证确认计数（2026-08-08，ref 协议对齐）：核心位置被视野覆盖
   *  确认缺失的次数——连续 2 次独立确认缺失才删除（防"暂时看不见"误删）；
   *  重新目击/迁移到新位置时清零。对应 guide：旧核重见但不在 → 标记待
   *  彻查 + 擦除区域，仅 DESTRUCTION_PARTICIPATION 或全区域覆盖才删。 */
  private readonly coreHuntMissingCount = new Map<string, number>();
  /** 敌 Core 兵力记忆（assault-overmatch-v1）：key = cellKey(敌 Core 位置)。 */
  private readonly enemyCoreForceRecords = new Map<string, {
    position: Position;
    vanguards: Set<string>;
    rangers: Set<string>;
    lastSeenTick: number;
  }>();
  /** 核心最近一次稳定（NORMAL）位置——迁移检测基准。 */
  private lastCoreStablePosition: Position | null = null;
  /** 核心迁移触发 worker 巡逻重置的次数（telemetry/测试可读）。 */
  corePatrolResetCount = 0;
  /** 最近一次巡逻重置 tick（从未触发 = null）。 */
  lastCorePatrolResetTick: number | null = null;
  /** 世界重置计数（tick 回退检测触发；决策层 telemetry/测试可读）。 */
  worldResetCount = 0;
  /** 最近一次世界重置发生时的 tick（从未重置 = null）。 */
  lastWorldResetTick: number | null = null;

  /**
   * C2 RECOVERY（竞品 lifecycle overlay 对照）：Core 重生（替换，全新 UUID）
   * 后清**相对 Core** 的战场记忆——敌追击积分（pursuitScore/coreDistance）
   * 与单位巡逻扇区（patrolDirection/patrolRing）基于旧 Core 坐标系，重生后
   * 失真（竞品 "RECOVERY clears battlefield memory, rebuilds locally"）。
   * 绝对坐标地图事实（障碍/资源/chunk 观察老化）保留——不随 Core 位置变化。
   * 返回被清条目数（telemetry/测试可读）。
   */
  clearBattlefieldMemory(): number {
    const cleared = this.enemyMemory.size + this.unitMemories.size + this.coreWatch.size;
    this.enemyMemory.clear();
    this.unitMemories.clear();
    this.coreWatch.clear();
    return cleared;
  }

  /** 核心迁移后重置 worker 巡逻记忆（2026-08-08，t2 生产实证）：
   *  patrolRing/patrolStarted/patrolReturning 基于旧 Core 坐标系，核心迁移后
   *  失真（worker 继续沿旧方位扫旧区域→资源枯竭区 WAIT）。仅重置巡逻状态，
   *  保留 patrolDirection（worker 各自扇区）与绝对坐标 intel（资源/敌情/chunk）。
   *  返回被重置条数。 */
  resetWorkerPatrolMemories(): number {
    let count = 0;
    for (const memory of this.unitMemories.values()) {
      if (memory.workerMode === "go_harvest") {
        memory.workerMode = "patrol";
        memory.harvestTarget = null;
      }
      memory.patrolRing = 0;
      memory.patrolStarted = false;
      memory.patrolReturning = false;
      count += 1;
    }
    return count;
  }

  /**
   * Worker 局部活性恢复时清掉该单位的短期 MOVE 失败避让缓存。
   * 这些缓存本来只有数 Tick TTL，但若正好与旧 patrol/矿目标形成反馈环，恢复后继续
   * 携带会把单位再次推回同一小环；局部恢复只清该 unit，不影响全局障碍事实。
   */
  clearUnitMoveFailures(unitId: string): number {
    const failures = this.unitMoveFailures.get(unitId);
    if (failures === undefined) return 0;
    const count = failures.size;
    this.unitMoveFailures.delete(unitId);
    return count;
  }

  observe(state: TickState): void {
    // 世界重置检测：tick 回退（服务器世界重置/异常）→ 全清本地记忆，避免幽灵障碍/资源
    if (this.tick > state.tick) {
      this.obstacleMemory.clear();
      this.surveyedEmpty.clear();
      this.resourceMemory.clear();
      this.enemyMemory.clear();
      this.failedCells.clear();
      this.unitMoveFailures.clear();
      this.unitMemories.clear();
      this.chunkMemory.clear();
      this.beaconHistory.length = 0;
      this.coreHuntMemory.clear();
      // 审计 W5（2026-08-10）：世界重置时残留 Map 未清——extendedFailedCooldowns /
      // resourceFailCounts / coreWatch / coreHuntMissingCount / enemyCoreForceRecords
      // 跨重置泄漏（旧 tick 系数的冷却覆盖 + 旧敌情记忆在全新世界里失真）。
      this.extendedFailedCooldowns.clear();
      this.resourceFailCounts.clear();
      this.coreWatch.clear();
      this.coreHuntMissingCount.clear();
      this.enemyCoreForceRecords.clear();
      this.worldResetCount += 1;
      this.lastWorldResetTick = state.tick;
    }
    this.tick = state.tick;
    // 核心迁移巡逻重置（2026-08-08，t2 生产实证）：核心稳定位置显著变化
    // （≥ 5 格 = 迁移）→ 重置 worker 巡逻记忆。仅 NORMAL 时检测/更新基准
    // （MOVING 是迁移途中，不重置避免反复打断；到达稳定后一次性触发）。
    if (state.core !== null && state.core.state === "NORMAL") {
      const cp = state.core.position;
      if (this.lastCoreStablePosition !== null &&
          chebyshev(cp, this.lastCoreStablePosition) >= CORE_PATROL_RESET_THRESHOLD) {
        const cleared = this.resetWorkerPatrolMemories();
        if (cleared > 0) {
          this.corePatrolResetCount += 1;
          this.lastCorePatrolResetTick = state.tick;
        }
      }
      this.lastCoreStablePosition = cp;
    }
    this.beaconHistory.push({ tick: state.tick, position: state.beacon.position });
    if (this.beaconHistory.length > BEACON_HISTORY_MAX) this.beaconHistory.shift();
    for (const cell of state.obstacleCells) this.obstacleMemory.add(cell);
    for (const cell of state.obstacleCells) this.chunkMemory.set(chunkKeyFor(parseCellKey(cell)), state.tick);

    // fog-of-war shooting gate（2026-08-10）：记录进入友方视野半径内且不在
    // 障碍列表的格为"已观测空地"。lineBlocked 只查障碍集——不在障碍集
    // 中的格被当作空地，但"从未观测的迷雾格"也恰不在障碍集中 → 误判可射击
    // → 引擎知道是障碍 → SHOT_MISSED。surveyedEmpty 使 isCellObserved 能区分
    // "已观测空"和"未观测迷雾"，decideRanger 对迷雾中间格保守不开火。
    // 不查视线遮挡（乐观近似：被障碍遮挡的格也被标空，但那障碍本身在障碍集
    // 中会被 lineBlocked 拦截，不影响射击线判定）。
    const visibleObstacles = state.obstacleCells;
    const surveyUnit = (origin: Position, radius: number): void => {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const remaining = radius - Math.abs(dx);
        for (let dy = -remaining; dy <= remaining; dy += 1) {
          const key = cellKey([origin[0] + dx, origin[1] + dy]);
          if (!visibleObstacles.has(key)) this.surveyedEmpty.add(key);
        }
      }
    };
    if (state.core !== null) surveyUnit(state.core.position, VISION_RADIUS.CORE);
    for (const unit of state.units) {
      surveyUnit(unit.position, VISION_RADIUS[unit.unitType]);
    }

    const visibleResources = new Set(state.resourceCells);
    for (const cell of visibleResources) {
      const previous = this.resourceMemory.get(cell);
      this.resourceMemory.set(cell, {
        cell: parseCellKey(cell),
        state: "visible",
        firstSeenTick: previous?.firstSeenTick ?? state.tick,
        lastSeenTick: state.tick,
      });
      // GAP 1.3：矿刷新（visible）→ 重置失败计数。矿之前被证伪是因为空了，
      // 现在 visible = refill 了，旧失败不计——否则刚刷新就因旧 3 次计数
      // 仍在 96 tick 冷却中被跳过。
      this.resourceFailCounts.delete(cell);
      // 审计 W3（2026-08-10）：extendedFailedCooldowns 同步重置——旧版只清
      // resourceFailCounts，分级冷却覆盖残留 → 矿 refill 后仍被 96/192/384
      // 冷却压制（语义错误），且 Map 无界增长（泄漏）。
      this.extendedFailedCooldowns.delete(cell);
    }
    for (const [cell, memory] of this.resourceMemory) {
      if (visibleResources.has(cell)) continue;
      if (memory.state === "harvested") continue; // 自采成功/确认耗尽保持负记忆
      // 视线感知资源失效（ref arena-hero-agent _refresh_resource_memory：
      // definitely_visible && not in current_resources → 立即失效）：
      // 格子被任意我方观察者确认可见（Manhattan 半径 + supercover 无遮挡）
      // 却不在本轮 visibleResources → 资源已被采空 → 直接记 harvested 负记忆
      // （不进 hints，TTL 后删除），杜绝 worker 跨 30-78 格追空矿
      // （t4 实证 go_harvest_mem 104 意图仅 12 次成功）。
      // 2026-08-08 v2 扩展：检查面从 visible 扩到 stale/seeded——被视野确认
      // 无矿的陈旧种子立即证伪（t2 实证：561 个跨 run 种子永不过期，12 空
      // worker 反复追死种子、两格乒乓；worker 视野 3×3 覆盖周边死种子却不
      // 证伪 = 只能逐格推进）。负证据（实地视野确认）优先于陈旧正记忆（测绘
      // 种子）；refill 后重新可见即恢复（上一循环无条件覆盖为 visible）。
      if (this.visionInvalidation && resourceCellCoveredByVision(state, parseCellKey(cell), this.obstacleMemory)) {
        memory.state = "harvested";
      } else if (memory.state === "visible") {
        // 未被视野确认（可能藏在障碍后/移远）：visible 降级 stale 保持提示。
        memory.state = "stale";
      }
    }

    for (const event of state.events) {
      if (event.position === undefined) continue;
      const cell = cellKey(event.position);
      if (event.eventType === "HARVEST_FAILED") {
        // reasonCode 分流：CARGO_FULL 表示格子仍有资源（cargo 满）——不写失败
        // 冷却、不降级；RESOURCE_DEPLETED（被他人采空）→ 失败冷却 + 降级 stale。
        // NOT_RESOURCE_CELL（记忆格已不存在/已耗尽——t4 实证 go_harvest_mem 104
        // 意图仅 12 次成功、worker 跨 30-78 格追空记忆）→ 记 harvested 负记忆
        // （不进 hints，visited-empty 立即失效，杜绝多 worker 反复追同一死矿）。
        // 不写 failedCells：refill 后重新可见即恢复（failedCells 会误压可见矿）。
        if (event.reasonCode === "RESOURCE_DEPLETED") {
          this.failedCells.set(cell, state.tick);
          const memory = this.resourceMemory.get(cell);
          if (memory?.state === "visible") memory.state = "stale";
        } else if (event.reasonCode === "NOT_RESOURCE_CELL") {
          const memory = this.resourceMemory.get(cell);
          if (memory !== undefined) memory.state = "harvested";
        }
      } else if (event.eventType === "HARVEST_SUCCEEDED") {
        const previous = this.resourceMemory.get(cell);
        this.resourceMemory.set(cell, {
          cell: event.position,
          state: "harvested",
          firstSeenTick: previous?.firstSeenTick ?? state.tick,
          lastSeenTick: state.tick,
        });
      } else if (
        event.eventType === "UNIT_MOVE_FAILED" &&
        event.actorId !== null &&
        event.reasonCode !== null &&
        TRANSIENT_MOVE_FAILURE_REASONS.has(event.reasonCode)
      ) {
        let failures = this.unitMoveFailures.get(event.actorId);
        if (failures === undefined) {
          failures = new Map<string, number>();
          this.unitMoveFailures.set(event.actorId, failures);
        }
        failures.set(cell, state.tick);
      }
    }

    for (const enemy of state.visibleEnemies) {
      const previous = this.enemyMemory.get(enemy.id);
      const core = state.core?.position;
      let pursuitScore = 0;
      let coreDistance: number | undefined;
      if (core !== undefined) {
        coreDistance = Math.max(
          Math.abs(enemy.position[0] - core[0]),
          Math.abs(enemy.position[1] - core[1]),
        );
        // 追击积分（竞品 pursuit score 对照）：距离差分——closed = prev.d - cur.d，
        // >0 逼近 +2、==0 平行 +1、<0 远离 -1；位置未动强制 0（静态敌不算——
        // 天然滤除"路过"误报：远离衰减、平行封顶）。cap [0,4]。
        if (previous !== undefined && previous.coreDistance !== undefined) {
          // 位置未动判定用上一 tick 位置（previous.position——prevPosition 是
          // 上上 tick，仅用于威胁评估的移动检测）
          const moved =
            previous.position[0] !== enemy.position[0] ||
            previous.position[1] !== enemy.position[1];
          if (!moved) {
            pursuitScore = 0;
          } else {
            const closed = previous.coreDistance - coreDistance;
            const delta = closed > 0 ? 2 : closed === 0 ? 1 : -1;
            pursuitScore = Math.max(0, Math.min(4, (previous.pursuitScore ?? 0) + delta));
          }
        }
      }
      this.enemyMemory.set(enemy.id, {
        id: enemy.id,
        position: enemy.position,
        // 位置差分：上一次可见位置保留为 prevPosition（同 id 才记录——
        // 新出现敌人无 prev，prevPosition 缺失 = 无法判断移动）。
        prevPosition: previous?.position,
        prevSeenTick: previous?.lastSeenTick,
        coreDistance,
        pursuitScore,
        kind: enemy.kind,
        unitType: enemy.unitType,
        lastSeenTick: state.tick,
      });
      // 近核入侵观察（2026-08-08，core-threat-watch-v1）：敌单位距我方 Core
      // ≤ CORE_WATCH_RADIUS 即入长 TTL 观察（enemyHints 6 tick 会漏盘踞/间歇
      // 可见的近核敌情——t2 实证敌 WORKER 离核 2 格盘踞 600+ tick）。静止 =
      // 连续目击同格。供威胁 ALERT（战斗单位）与 Vanguard 回访清剿消费。
      if (core !== undefined && coreDistance !== undefined && coreDistance <= CORE_WATCH_RADIUS) {
        const prevWatch = this.coreWatch.get(enemy.id);
        this.coreWatch.set(enemy.id, {
          id: enemy.id,
          position: enemy.position,
          kind: enemy.kind,
          unitType: enemy.unitType,
          stationary:
            prevWatch !== undefined &&
            prevWatch.position[0] === enemy.position[0] &&
            prevWatch.position[1] === enemy.position[1],
          coreDistance,
          lastSeenTick: state.tick,
        });
      }
      // 敌情狩猎（2026-08-07）：CORE 目击 → sticky 基地目标；WORKER 目击 →
      // 推断基地候选（轨迹双向延伸 / 单次目击远离我方猜测——竞品 worker
      // trajectory 推断 Core 方向）。同一格保留更新鲜的目击。
      if (enemy.kind === "CORE") {
        const key = cellKey(enemy.position);
        // 旧核验证协议（2026-08-08，ref 对齐）：同 enemy id 迁移 → 删旧位置条目，
        // 杜绝"地图上两个同款核心"幽灵（核心迁移后旧位置 sticky 2000 tick 不清）。
        if (enemy.id !== undefined && enemy.id !== null) {
          for (const [oldKey, target] of this.coreHuntMemory) {
            if (
              oldKey !== key &&
              target.source === "CORE" &&
              target.ownerId === enemy.id
            ) {
              this.coreHuntMemory.delete(oldKey);
              this.coreHuntMissingCount.delete(oldKey);
              // P0 修复：Core 迁移时同步清理旧位置的 enemyCoreForceRecords，
              // 防旧 key 的 unit-ID Set 永久 orphan（旧位置不再在 coreHuntMemory
              // 中，confirmCoreHuntMissing 永远查不到、永不清理）。
              this.enemyCoreForceRecords.delete(oldKey);
            }
          }
        }
        this.coreHuntMissingCount.delete(key);
        this.coreHuntMemory.set(key, {
          position: enemy.position,
          lastSeenTick: state.tick,
          source: "CORE",
          owner: enemy.ownerUsername ?? null,
          ownerId: enemy.id ?? null,
        });
      } else if (enemy.unitType === "VANGUARD" || enemy.unitType === "RANGER") {
        // 敌 Core 兵力记忆（assault-overmatch-v1）：战斗单位分配给最近已知
        // 敌 Core（CORE 目击优先）——按 Core 估计守军兵力供严格占优攻坚。
        const assigned = this.assignEnemyCombatUnit(enemy, state.tick);
        if (assigned !== null) {
          const key = cellKey(assigned.position);
          const record = this.enemyCoreForceRecords.get(key) ?? {
            position: assigned.position,
            vanguards: new Set<string>(),
            rangers: new Set<string>(),
            lastSeenTick: 0,
          };
          if (enemy.unitType === "VANGUARD") record.vanguards.add(enemy.id);
          else record.rangers.add(enemy.id);
          record.lastSeenTick = state.tick;
          this.enemyCoreForceRecords.set(key, record);
        }
      } else if (enemy.unitType === "WORKER") {
        for (const anchor of this.inferWorkerCoreAnchors(enemy, state)) {
          const key = cellKey(anchor);
          const existing = this.coreHuntMemory.get(key);
          if (existing === undefined || existing.lastSeenTick < state.tick) {
            this.coreHuntMemory.set(key, {
              position: anchor,
              lastSeenTick: state.tick,
              source: "WORKER_INFER",
            });
          }
        }
      }
    }

    const liveUnits = new Set(state.units.map((unit) => unit.id));
    for (const unitId of this.unitMemories.keys()) {
      if (!liveUnits.has(unitId)) this.unitMemories.delete(unitId);
    }
    for (const unitId of this.unitMoveFailures.keys()) {
      if (!liveUnits.has(unitId)) this.unitMoveFailures.delete(unitId);
    }

    // 资源记忆过期：stale/harvested 超过 TTL（≈4 个 refill 周期）删除——
    // 若 refill 会重新可见（重新入记忆），未恢复说明已被采空/不再生成。
    for (const [cell, memory] of this.resourceMemory) {
      if (memory.state !== "visible" && memory.seeded !== true && state.tick - memory.lastSeenTick > RESOURCE_MEMORY_TTL_TICKS) {
        this.resourceMemory.delete(cell);
        this.failedCells.delete(cell);
        // 审计 W3（2026-08-10）：TTL 过期同步清失败计数与分级冷却——
        // 记忆删除后计数/冷却残留 = 无界增长 + 幽灵冷却（格子重新出现时
        // 被旧 96/192/384 tick 覆盖压制）。
        this.resourceFailCounts.delete(cell);
        this.extendedFailedCooldowns.delete(cell);
      }
    }

    // 审计 W5（2026-08-10）：敌情记忆常规 TTL 清理——enemyMemory / coreWatch /
    // enemyCoreForceRecords 只有"读取时 maxAge 过滤"没有"写入侧删除"，
    // 长局每个目击过的敌单位 id / 近核观察 / 敌核兵力记录永久残留（无界
    // 增长）。读取过滤仍生效，这里只删远超战术窗口的条目（保守 TTL，
    // 不影响 6/12/60/2000 tick 战术记忆窗口）。
    const ENEMY_MEMORY_MAX_AGE = 2000; // 与 CORE_HUNT_STICKY_TICKS 同量级
    for (const [enemyId, memory] of this.enemyMemory) {
      if (state.tick - memory.lastSeenTick > ENEMY_MEMORY_MAX_AGE) {
        this.enemyMemory.delete(enemyId);
        this.coreWatch.delete(enemyId);
      }
    }
    for (const [watchId, watch] of this.coreWatch) {
      if (state.tick - watch.lastSeenTick > CORE_WATCH_TTL * 4) {
        this.coreWatch.delete(watchId);
      }
    }
    for (const [key, record] of this.enemyCoreForceRecords) {
      if (state.tick - record.lastSeenTick > ENEMY_MEMORY_MAX_AGE) {
        this.enemyCoreForceRecords.delete(key);
      }
    }

    // chunk 老化更新：所有视野实体格（资源/敌人/我方单位/Core/Beacon）——
    // 巡逻与采集到达的区域随实体观察刷新"最近观察时间"。
    for (const cell of visibleResources) this.chunkMemory.set(chunkKeyFor(parseCellKey(cell)), state.tick);
    for (const enemy of state.visibleEnemies) this.chunkMemory.set(chunkKeyFor(enemy.position), state.tick);
    for (const unit of state.units) this.chunkMemory.set(chunkKeyFor(unit.position), state.tick);
    if (state.core !== null) this.chunkMemory.set(chunkKeyFor(state.core.position), state.tick);
    this.chunkMemory.set(chunkKeyFor(state.beacon.position), state.tick);

    // 旧核验证协议（2026-08-08，ref 对齐）：视野覆盖确认缺失——我方单位视野
    // （按类型半径：worker 3/vanguard 4/ranger 5）覆盖核心记忆位置且无遮挡、
    // 且可见敌人中无 CORE 实体在该格 → confirmCoreHuntMissing（连续 2 次确认
    // 才删）。解决"地图上两个同款核心/军事打空城"：核心被毁/迁移后，视野
    // 覆盖确认其不在旧位置，sticky 记忆被清理。视线遮挡（障碍）时不确认——
    // 只是"看不见"不是"确认不在"。
    // sim visibility 是 Manhattan 视野（官方：|dx|+|dy| ≤ radius 且无遮挡）——
    // 用 Manhattan 判定"视野覆盖"，Chebyshev 会把 Manhattan 8 处的单位误判为
    // 覆盖（生产实证：t57 军事在核心 Manhattan 8 处被误判确认缺失 → 死核被删
    // → vanguard_hunt 中断）。worker 3 / vanguard 4 / ranger 5 / core 5。
    const UNIT_VISION_RADIUS: Readonly<Record<string, number>> = { WORKER: 3, VANGUARD: 4, RANGER: 5 };
    const visibleCoreCells = new Set(
      state.visibleEnemies
        .filter((enemy) => enemy.kind === "CORE")
        .map((enemy) => cellKey(enemy.position)),
    );
    for (const [key, target] of this.coreHuntMemory) {
      if (target.source !== "CORE") continue;
      let covered = false;
      for (const unit of state.units) {
        const radius = UNIT_VISION_RADIUS[unit.unitType] ?? 3;
        if (manhattan(unit.position, target.position) > radius) continue;
        if (lineBlocked(unit.position, target.position, this.obstacleMemory)) continue;
        covered = true;
        break;
      }
      if (state.core !== null) {
        const coreRadius = 5;
        if (manhattan(state.core.position, target.position) <= coreRadius) covered = true;
      }
      if (covered && !visibleCoreCells.has(key)) {
        this.confirmCoreHuntMissing(target.position);
      }
    }
  }

  unitMemory(unitId: string, initialPatrolDirection = 0): UnitMemory {
    let memory = this.unitMemories.get(unitId);
    if (memory === undefined) {
      memory = {
        workerMode: "patrol",
        harvestTarget: null,
        patrolDirection: initialPatrolDirection,
        patrolRing: 0,
        patrolStarted: false,
        patrolReturning: false,
        lastTick: this.tick,
      };
      this.unitMemories.set(unitId, memory);
    }
    memory.lastTick = this.tick;
    return memory;
  }

  obstacles(extra: ReadonlySet<string> = new Set()): ReadonlySet<string> {
    return new Set([...this.obstacleMemory, ...extra]);
  }

  /** 格级已观测判定（fog-of-war shooting gate）：格在障碍记忆或空地记忆
   *  中 = 已观测。两者都不在 = 从未进入友方视野 = 迷雾。decideRanger 对
   *  射击线中间格未观测时保守不开火，避免迷雾障碍导致 SHOT_MISSED。 */
  isCellObserved(cell: Position): boolean {
    const key = cellKey(cell);
    return this.obstacleMemory.has(key) || this.surveyedEmpty.has(key);
  }

  /**
   * 单位级动态避让：服务端 MOVE_CONTESTED 等失败不代表永久地形障碍，
   * 只在短冷却内阻止同一 actor 立即重试同一目的格。
   */
  movementObstacles(
    unitId: string,
    base: ReadonlySet<string> = new Set(),
    cooldownTicks = 3,
  ): ReadonlySet<string> {
    const result = new Set(base);
    const failures = this.unitMoveFailures.get(unitId);
    if (failures === undefined) return result;
    for (const [cell, failedAt] of failures) {
      if (this.tick - failedAt < cooldownTicks) result.add(cell);
      else failures.delete(cell);
    }
    if (failures.size === 0) this.unitMoveFailures.delete(unitId);
    return result;
  }

  /** 跨 run 测绘种子（2026-08-08，survey-db 联动）：把已知矿注入资源记忆——
   *  worker 重启后不再从零探索（"矿发现了没标注/没分配去挖"的持久化端）。
   *  state=stale、lastSeenTick=nowTick（纳入 hints 窗口）；后续真实可见/采集
   *  自然刷新状态。返回实际注入格数（已记忆的跳过）。 */
  seedResourceMemory(cells: readonly Position[], nowTick: number): number {
    let n = 0;
    for (const cell of cells) {
      const key = cellKey(cell);
      if (this.resourceMemory.has(key)) continue;
      this.resourceMemory.set(key, {
        cell,
        state: "stale",
        firstSeenTick: nowTick,
        lastSeenTick: nowTick,
        seeded: true,
      });
      n += 1;
    }
    return n;
  }

  /** 死矿证伪（2026-08-08，t2 生产实证死种子循环根治）：worker 实地到达记忆矿
   *  格却发现该格当前不可见/采不到（visible=false 的记忆/seed 矿，格上无实体
   *  资源）→ 写失败冷却，resourceCandidates 在 failedCooldown 内跳过该格——
   *  "追一次即证伪"，杜绝 worker 反复被重派到同一死种子（两格乒乓的根因，
   *  t2 实证 osc=11/11）。与 refill 兼容：矿真的刷新后重新可见，visible 优先
   *  于失败冷却，证伪只压 stale/seeded 记忆，不拦真矿。 */
  markResourceFailed(position: Position): void {
    const key = cellKey(position);
    this.failedCells.set(key, this.tick);
    // GAP 1.3 渐进冷却升级：同一格反复失败 → 升级冷却防 32-tick 周期振荡
    const failCount = (this.resourceFailCounts.get(key) ?? 0) + 1;
    this.resourceFailCounts.set(key, failCount);
    if (failCount === 3) {
      this.extendedFailedCooldowns.set(key, 96);
    } else if (failCount === 6) {
      this.extendedFailedCooldowns.set(key, 192);
    } else if (failCount >= 10) {
      this.extendedFailedCooldowns.set(key, 384);
    }
  }

  /** 分级冷却播种（2026-08-08，缺席实证）：survey-db 缺席统计（视野确认无矿
   *  的负观测）分级注入——高频缺席格（如 t2 561 格中 p90 缺席 1378 次）的
   *  失败冷却从默认 32 tick 升级到 96/192/384 tick，worker 重启后不再每 32
   *  tick 白试一次长期死格。可见优先语义不变：矿真刷新且被视野看到立即恢复
   *  （resourceCandidates 第一分支，冷却不拦真矿）。只覆盖有记录的格，无缺席
   *  记录的格走默认冷却（零回归）。 */
  seedFailedCooldownTiers(entries: readonly { position: Position; cooldownTicks: number }[]): number {
    let n = 0;
    for (const entry of entries) {
      const key = cellKey(entry.position);
      if (!this.extendedFailedCooldowns.has(key)) {
        this.extendedFailedCooldowns.set(key, entry.cooldownTicks);
        n += 1;
      }
    }
    return n;
  }


  /** 启动播种（2026-08-08，测绘库跨 run 障碍）：把测绘库累积的静态障碍注入
   *  obstacleMemory——障碍是静态地形，重启后导航/路径规划直接准确，无需
   *  重新探索（解决"重启→障碍记忆清零→寻路盲撞"）。返回实际注入格数。 */
  seedObstacleMemory(cells: readonly Position[]): number {
    let n = 0;
    for (const cell of cells) {
      const key = cellKey(cell);
      if (this.obstacleMemory.has(key)) continue;
      this.obstacleMemory.add(key);
      n += 1;
    }
    return n;
  }

  /** 启动播种（2026-08-08，测绘库跨 run 探索分区）：把测绘库累积的 chunk 最后
   *  探索 tick 注入 chunkMemory——"探索过的区域"跨重启保留，frontier 探索
   *  （未观察分区优先）直接可用，无需重新扫图。只覆盖更新的 tick。 */
  seedChunkMemory(chunks: readonly { key: string; lastSeenTick: number }[]): number {
    let n = 0;
    for (const c of chunks) {
      const prev = this.chunkMemory.get(c.key);
      if (prev === undefined || prev < c.lastSeenTick) {
        this.chunkMemory.set(c.key, c.lastSeenTick);
        n += 1;
      }
    }
    return n;
  }
  /** 资源任务候选的单一事实源（生产回流 99b4ba2）：返回可见 + 合法 stale/seeded
   *  记忆，并保留新鲜度/seed 元数据给全局任务分配器做置信代价。harvested 与
   *  失败冷却中的格永远不进入候选。返回值是复制快照，调用方不能修改 World
   *  内部记忆。
   *
   *  maxAge 8→32、failedCooldown 4→32（2026-08-06 生产实证配对）：
   *  - 记忆窗口 32 tick：巡逻环升级需要数十 tick（8 worker 分头巡逻一圈），
   *    stale 记忆 8 tick 就过期导致"刚见过就忘"（t1 生产 40 格矿测绘不到）；
   *  - 耗尽冷却 32 tick：RESOURCE_DEPLETED 确认的矿 32 tick 内不再提示——
   *    否则 worker 反复试近处空矿（t1 生产 maxDist 12-17 空转近处、巡逻环
   *    永不推进的证据），冷却与记忆窗口同量级防空转。 */
  resourceCandidates(options: { maxAge?: number; failedCooldown?: number } = {}): readonly ResourceCandidate[] {
    const maxAge = options.maxAge ?? 32;
    const failedCooldown = options.failedCooldown ?? 32;
    const visible: ResourceMemory[] = [];
    const recent: ResourceMemory[] = [];
    for (const memory of this.resourceMemory.values()) {
      // 本 Tick 可见 = 实体资源在场（正信号），不受失败冷却压制（2026-08-08：
      // markResourceFailed 只压 stale/seeded 记忆，refill 后重新可见即恢复）。
      if (memory.state === "visible") {
        visible.push(memory);
        continue;
      }
      const failedAt = this.failedCells.get(cellKey(memory.cell)) ?? Number.NEGATIVE_INFINITY;
      // 分级冷却（2026-08-08，缺席实证）：该格有缺席统计升级的冷却时长则用之，
      // 否则走默认冷却——高频缺席格（长期死）不每 32 tick 白试一次。
      const effectiveCooldown = this.extendedFailedCooldowns.get(cellKey(memory.cell)) ?? failedCooldown;
      if (this.tick - failedAt < effectiveCooldown) continue;
      if (memory.state === "stale" && (memory.seeded === true || this.tick - memory.lastSeenTick <= maxAge)) recent.push(memory);
    }
    const compare = (a: ResourceMemory, b: ResourceMemory) =>
      b.lastSeenTick - a.lastSeenTick || a.cell[0] - b.cell[0] || a.cell[1] - b.cell[1];
    return [...visible.sort(compare), ...recent.sort(compare)].map((memory) => ({
      cell: [memory.cell[0], memory.cell[1]] as Position,
      state: memory.state as "visible" | "stale",
      firstSeenTick: memory.firstSeenTick,
      lastSeenTick: memory.lastSeenTick,
      seeded: memory.seeded === true,
    }));
  }

  resourceHints(options: { maxAge?: number; failedCooldown?: number } = {}): readonly Position[] {
    return this.resourceCandidates(options).map((candidate) => candidate.cell);
  }

  enemyHints(maxAge = 6): readonly EnemyMemory[] {
    return [...this.enemyMemory.values()]
      .filter((memory) => this.tick - memory.lastSeenTick <= maxAge)
      .sort((a, b) => b.lastSeenTick - a.lastSeenTick || a.id.localeCompare(b.id));
  }

  /** 挂机 WORKER 狩猎目标（2026-08-08，用户"挂机/落单单位赶紧打掉"）：EnemyMemory
   *  中"确认静止"（上一可见位置 === 当前位置，即连续两次目击同位置）的敌方
   *  WORKER，短 TTL 内存——白赚断经济目标（WORKER 无攻击力、无反击）。与可见
   *  prey 互补：可见走 vanguardPreyWorker（12 格），短暂失明后的静止 WORKER 由
   *  这里按记忆回访（半径/TTL 有界，防远征）。单次目击（无 prevPosition）不算
   *  静止；敌核心格上的 WORKER 由调用方 nearEnemyCore 守卫排除。 */
  stationaryWorkerTargets(maxAgeTicks = 12): readonly { id: string; position: Position; lastSeenTick: number }[] {
    return [...this.enemyMemory.values()]
      .filter(
        (memory) =>
          memory.kind === "UNIT" &&
          memory.unitType === "WORKER" &&
          memory.prevPosition !== undefined &&
          memory.prevPosition[0] === memory.position[0] &&
          memory.prevPosition[1] === memory.position[1] &&
          this.tick - memory.lastSeenTick <= maxAgeTicks,
      )
      .sort((a, b) => b.lastSeenTick - a.lastSeenTick || a.id.localeCompare(b.id))
      .map((memory) => ({ id: memory.id, position: memory.position, lastSeenTick: memory.lastSeenTick }));
  }

  /** 近核入侵观察目标（2026-08-08，core-threat-watch-v1）：长 TTL 内目击过、
   *  目击时距 Core ≤ CORE_WATCH_RADIUS 的敌单位。coreDistance 用目击时快照
   *  （不随 Core 迁移重算——迁移后由新目击重建观察）。排序：最近目击优先。 */
  coreWatchTargets(maxAge = CORE_WATCH_TTL): readonly CoreWatchMemory[] {
    return [...this.coreWatch.values()]
      .filter((memory) => this.tick - memory.lastSeenTick <= maxAge)
      .sort((a, b) => b.lastSeenTick - a.lastSeenTick || a.id.localeCompare(b.id));
  }

  /** 敌情狩猎目标（排序：CORE 目击优先 → 新鲜度 → 坐标 tie-break）。
   *  CORE 目击 sticky（maxAge = CORE_HUNT_STICKY_TICKS）；WORKER_INFER
   *  短窗口（CORE_HUNT_WORKER_INFER_TICKS）——推断目标会漂移。 */
  /** 信标是否在近 withinTicks 内移动过（≥2 个不同位置）。移动中的信标 =
   *  被敌方核心携带/漂移——单骑追标会深入敌区送死（t2 生产实证 2026-08-08：
   *  信标被 jerkman 核心带着沿 y=0 东移，vanguard 北上追标 = 送人头）。
   *  静止（真掉落）才可 fetch。 */
  beaconMoving(withinTicks: number): boolean {
    if (withinTicks <= 0 || this.beaconHistory.length < 2) return false;
    const since = this.tick - withinTicks;
    const seen = new Set<string>();
    for (const entry of this.beaconHistory) {
      if (entry.tick < since) continue;
      seen.add(entry.position[0] + "," + entry.position[1]);
      if (seen.size >= 2) return true;
    }
    return false;
  }

  coreHuntTargets(maxAge?: number): readonly CoreHuntTarget[] {
    const coreAge = maxAge ?? CORE_HUNT_STICKY_TICKS;
    const workerAge = maxAge ?? CORE_HUNT_WORKER_INFER_TICKS;
    return [...this.coreHuntMemory.values()]
      .filter((target) => {
        const age = this.tick - target.lastSeenTick;
        return age <= (target.source === "CORE" ? coreAge : workerAge);
      })
      .sort((a, b) => {
        const pa = a.source === "CORE" ? 1 : 0;
        const pb = b.source === "CORE" ? 1 : 0;
        return (
          pb - pa ||
          b.lastSeenTick - a.lastSeenTick ||
          a.position[0] - b.position[0] ||
          a.position[1] - b.position[1]
        );
      });
  }

  /** 威胁方向扇区（threat-sector-scout-v1，2026-08-07）：首个 CORE 目击
   *  敌核心相对 home 的 8 方位索引（0=E,1=SE,2=S,3=SW,4=W,5=NW,6=N,7=NE，
   *  与 nav EXPLORE_DELTAS 同语义）——供 worker 巡逻方位向威胁方向加权
   *  （补侦察盲区：t2 生产实证 NE=jerkman 来路只有 1/12 worker，小股部队
   *  摸过来看不见）。无 CORE 目标返回 null（不加权）。 */
  threatSectorFrom(home: Position): number | null {
    const target = this.coreHuntTargets().find((t) => t.source === "CORE");
    if (target === undefined) return null;
    const dx = target.position[0] - home[0];
    const dy = target.position[1] - home[1];
    if (dx === 0 && dy === 0) return 0;
    const angle = Math.atan2(dy, dx);
    return (Math.round(angle / (Math.PI / 4)) + 8) % 8;
  }

  /** 启动播种（持久敌情测绘，2026-08-07）：从本租户历史 calibration cases
   *  提取的"最后已知敌 Core 位置"注入——重启后军事仍记得敌方基地（解决
   *  "重启→记忆清零→军队空转"）。更新鲜的目击不覆盖。返回实际播种数。 */
  seedCoreHuntTargets(targets: readonly CoreHuntTarget[]): number {
    let seeded = 0;
    for (const target of targets) {
      const key = cellKey(target.position);
      const existing = this.coreHuntMemory.get(key);
      if (existing === undefined || existing.lastSeenTick < target.lastSeenTick) {
        this.coreHuntMemory.set(key, { ...target });
        seeded += 1;
      }
    }
    return seeded;
  }

  /** 旧核验证协议：DESTRUCTION_PARTICIPATION（CORE）事件删除（2026-08-08，
   *  ref 对齐）——敌核心被摧毁的强信号，直接删除记忆 + 兵力估计，军事不再
   *  反复去打已毁核心（用户反馈"地方核心还活着吗？为啥不去打掉"——死核
   *  残留导致军事打空城）。无目标返回 false。 */
  forgetCoreHuntAt(position: Position): boolean {
    const key = cellKey(position);
    const existed = this.coreHuntMemory.delete(key);

    this.coreHuntMissingCount.delete(key);
    this.enemyCoreForceRecords.delete(key);
    return existed;
  }

  /** GAP 1.1 recovery（2026-08-10）：清除所有敌核记忆。shot_missed_spiral
   *  恢复时调用——游侠记忆射击打的是陈旧敌核记忆格（死核/迁移核/重生核
   *  的旧格），清除后游侠不再对空枪。 */
  clearCoreHuntMemory(): number {
    const count = this.coreHuntMemory.size;
    this.coreHuntMemory.clear();
    this.coreHuntMissingCount.clear();
    this.enemyCoreForceRecords.clear();
    return count;
  }

  /** 旧核验证协议：DESTRUCTION_PARTICIPATION（CORE）事件同步清理 enemyMemory
   *  （2026-08-08 生产实证 t1：敌核 3fc73555 在 [-632,-126] 被拆后 enemyMemory
   *  的 CORE 条目残留 ~60 tick——ranger_memory_shot / vanguard_pressure_memory
   *  读 enemyHints()（enemyMemory）而非 coreHuntTargets()，导致 Ranger 对死核格
   *  空放枪（该格还站着己方 Vanguard，观感像打友军）、Vanguard 全吸到死核格
   *  capacity_wait 卡死。摧毁清理必须两处同步。返回是否删除了条目。 */
  forgetEnemyCoreAt(position: Position, id?: string | null): boolean {
    const key = cellKey(position);
    let removed = false;
    for (const [memId, memory] of this.enemyMemory) {
      if (memory.kind !== "CORE") continue;
      if (cellKey(memory.position) === key || (id !== undefined && id !== null && memory.id === id)) {
        this.enemyMemory.delete(memId);
        removed = true;
      }
    }
    return removed;
  }

  /** 旧核验证协议：视野覆盖确认缺失计数（2026-08-08，ref 对齐）——我方单位
   *  视野覆盖核心记忆位置但该格无 Core 实体 → 确认缺失计数 +1；连续 2 次
   *  独立确认才删除（防"暂时看不见"误删——障碍/视野边缘遮挡不是真缺失）。
   *  返回 true = 本 tick 确认缺失（可能尚未删除）；false = 已删除或未确认。
   *  重新目击/迁移由 observe 清零计数。 */
  confirmCoreHuntMissing(position: Position): boolean {
    const key = cellKey(position);
    const target = this.coreHuntMemory.get(key);
    if (target === undefined) return false;
    if (target.source !== "CORE") {
      // WORKER_INFER 猜测：无 Core 实体时直接删（短窗口推断，不配验证）
      this.coreHuntMemory.delete(key);
      this.coreHuntMissingCount.delete(key);
      return true;
    }
    const count = (this.coreHuntMissingCount.get(key) ?? 0) + 1;
    if (count >= 2) {
      this.coreHuntMemory.delete(key);
      this.coreHuntMissingCount.delete(key);
      this.enemyCoreForceRecords.delete(key);
      return true;
    }
    this.coreHuntMissingCount.set(key, count);
    return false;
  }

  /** 敌战斗单位 → 归属敌 Core（assault-overmatch-v1）：取最近已知敌 Core
   *  （CORE 目击优先，同 coreHuntTargets 排序），距其 ≤ ENEMY_CORE_ASSIGN_RADIUS
   *  才归属（防远征单位误计入无关基地）。无合适目标返回 null。 */
  private assignEnemyCombatUnit(enemy: VisibleEntity, tick: number): CoreHuntTarget | null {
    const target = this.coreHuntTargets().find(
      (t) => t.source === "CORE" && chebyshev(enemy.position, t.position) <= ENEMY_CORE_ASSIGN_RADIUS,
    );
    if (target === undefined) return null;
    return target;
  }

  /** 敌 Core 兵力记忆（assault-overmatch-v1）：返回每个已知敌 Core 的守军
   *  估计（Vanguard/Ranger 数量，按 ID 去重），过滤 maxAge 内新鲜度。
   *  排序：CORE 目击优先 → 新鲜度（与 coreHuntTargets 同口径）。 */
  enemyCoreForces(maxAge = 12): readonly EnemyCoreForce[] {
    const out: EnemyCoreForce[] = [];
    for (const [key, record] of this.enemyCoreForceRecords) {
      if (this.tick - record.lastSeenTick > maxAge) continue;
      out.push({
        position: record.position,
        vanguards: new Set(record.vanguards),
        rangers: new Set(record.rangers),
        lastSeenTick: record.lastSeenTick,
        key,
      });
    }
    out.sort((a, b) => {
      const pa = a.key && this.coreHuntMemory.get(a.key)?.source === "CORE" ? 1 : 0;
      const pb = b.key && this.coreHuntMemory.get(b.key)?.source === "CORE" ? 1 : 0;
      return pb - pa || b.lastSeenTick - a.lastSeenTick || a.position[0] - b.position[0] || a.position[1] - b.position[1];
    });
    return out;
  }

  /** 敌 Worker 目击 → 基地候选锚点（竞品 "worker trajectory 推断 Core 方向"）：
   *  - 有轨迹（prevPosition 且移动）：Worker 在 Core 与资源间往返——基地在轨迹
   *    两端之一，双向各延伸 CORE_HUNT_INFER_EXTEND（诚实覆盖，不猜来向）；
   *  - 单次目击（无轨迹）：沿"离最近我方单位最远"的 8 方位猜测（竞品保守
   *    "单次目击沿远离最近我方单位方向给出猜测"）。 */
  private inferWorkerCoreAnchors(
    enemy: VisibleEntity,
    state: TickState,
  ): readonly Position[] {
    const anchors: Position[] = [];
    const previous = this.enemyMemory.get(enemy.id);
    if (previous?.prevPosition !== undefined) {
      const dx = enemy.position[0] - previous.prevPosition[0];
      const dy = enemy.position[1] - previous.prevPosition[1];
      const steps = Math.max(Math.abs(dx), Math.abs(dy));
      if (steps > 0) {
        const nx = dx / steps;
        const ny = dy / steps;
        anchors.push([
          enemy.position[0] + Math.round(nx * CORE_HUNT_INFER_EXTEND),
          enemy.position[1] + Math.round(ny * CORE_HUNT_INFER_EXTEND),
        ]);
        anchors.push([
          enemy.position[0] - Math.round(nx * CORE_HUNT_INFER_EXTEND),
          enemy.position[1] - Math.round(ny * CORE_HUNT_INFER_EXTEND),
        ]);
      }
    }
    if (anchors.length === 0) {
      if (state.units.length === 0) return [enemy.position];
      let best: Position = enemy.position;
      let bestScore = -1;
      for (const [dx, dy] of HUNT_AWAY_DELTAS) {
        const candidate: Position = [
          enemy.position[0] + dx * CORE_HUNT_SINGLE_EXTEND,
          enemy.position[1] + dy * CORE_HUNT_SINGLE_EXTEND,
        ];
        let minD = Number.POSITIVE_INFINITY;
        for (const unit of state.units) {
          const d = chebyshev(candidate, unit.position);
          if (d < minD) minD = d;
        }
        if (minD > bestScore) {
          bestScore = minD;
          best = candidate;
        }
      }
      anchors.push(best);
    }
    return anchors;
  }

  /**
   * frontier 探索方位选择：8 方位按"当前巡逻环探测点所在 chunk 观察老化"排序，
   * 观察最老（lastSeen 最小）的方位优先；老化相同按方位升序（确定性 tie-break，
   * 全未观察时退化为固定方位序）。offset 按 worker 序号轮转——多 worker 分散到
   * 不同老分区，避免全部涌向同一最老方位（第二名"不要所有侦察走同一走廊"）。
   */
  staleDirection(
    home: Position,
    beacon: Position,
    ringIndex: number,
    baseRadius: number,
    count: number,
    offset: number,
  ): number {
    const radius = exploreRadiusForRing(baseRadius, ringIndex);
    const candidates = Array.from({ length: count }, (_, direction) => ({
      direction,
      lastSeen: this.chunkMemory.get(chunkKeyFor(exploreTarget(home, beacon, direction, radius))) ?? 0,
    }));
    candidates.sort((a, b) => a.lastSeen - b.lastSeen || a.direction - b.direction);
    return candidates[((offset % count) + count) % count].direction;
  }

  snapshot(): WorldSnapshot {
    return {
      tick: this.tick,
      obstacles: [...this.obstacleMemory].sort(),
      resources: [...this.resourceMemory.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([cell, memory]) => ({
          cell,
          state: memory.state,
          firstSeenTick: memory.firstSeenTick,
          lastSeenTick: memory.lastSeenTick,
        })),
      enemies: [...this.enemyMemory.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((memory) => ({
          id: memory.id,
          cell: cellKey(memory.position),
          kind: memory.kind,
          lastSeenTick: memory.lastSeenTick,
        })),
      unitModes: Object.fromEntries(
        [...this.unitMemories.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, memory]) => [id, memory.workerMode]),
      ),
      coreHuntTargets: [...this.coreHuntMemory.values()]
        .sort((a, b) => b.lastSeenTick - a.lastSeenTick || a.position[0] - b.position[0] || a.position[1] - b.position[1])
        .map((target) => ({
          position: target.position,
          source: target.source,
          lastSeenTick: target.lastSeenTick,
        })),
    };
  }
}








