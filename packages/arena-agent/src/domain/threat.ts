/**
 * 威胁评估（v0.3-lite 诊断层，2026-08-06）：
 * 竞品 hierarchical threat assessment 对照——先做纯函数诊断（不改任何行为），
 * 输出威胁等级 + reason，供 telemetry/replay 分析；行为接线（ALERT 召回、
 * PRE_EVADE Core 迁移）等 P05/P06 验证后按差距清单逐步接入。
 *
 * 等级（确定性级联，保守优先）：
 * - ENGAGED：本 tick 我方 Core 受击（CORE_DAMAGED/CORE_DESTROYED——单位受击
 *   不升级 Core 级，2026-08-07 竞品 recent_core_attack 分账对齐）
 * - BREAKOUT：可见敌 ≥2 且相对 Core 轴数 ≥2 且**当前格投影伤害 >0**（至少
 *   一敌能合法攻击 Core）且**无逃逸方向**（障碍/资源/敌占格为硬块——竞品
 *   multi-axis breakout 对齐：多轴但存在某方向使全部敌距离增加 = 可逃，
 *   不算被包围；C5 修正"12 格内"前提——打不到的远处包围不算 BREAKOUT）
 * - ALERT：可见敌移动（位置差分）或可见敌距 Core ≤12（回退半径）
 * - NORMAL：其他
 */
import { type Position, type VisibleEntity } from "./model.ts";
import { lineBlocked } from "./nav.ts";
import type { CoreWatchMemory, EnemyMemory } from "./world.ts";

export type ThreatLevel = "NORMAL" | "ALERT" | "ENGAGED" | "BREAKOUT";

export interface ThreatAssessment {
  readonly level: ThreatLevel;
  readonly reason: string | null;
  /** 距 Core ≤ 12 格的可见敌数量（回退半径内）。 */
  readonly closingEnemies: number;
  /** 位置差分检测到移动的可见敌数量。 */
  readonly movingEnemies: number;
  /** 可见敌相对 Core 的 45° 轴数（≥2 = 多轴夹击候选）。 */
  readonly axes: number;
  /** 确认追击（积分 >0 且（12 格内 或 积分 ≥3 持续逼近））——竞品
   *  pursuing_enemy_ids 对照，供 decideCore 消费（远距确认追击也触发迁移）。 */
  readonly confirmedPursuit: boolean;
}

/** 回退半径（竞品 12-cell fallback）：ALERT 触发条件之一。 */
export const THREAT_FALLBACK_RADIUS = 12;

/** 受击记忆窗口（tick 数，对齐竞品 RECENT_ATTACK_MEMORY_TICKS=6）：Core 受击后
 *  即使敌人消失/不可见，威胁保持 ENGAGED 一段时间，防“打完就跑”后立刻放松。 */
export const RECENT_ATTACK_MEMORY_TICKS = 6;

/** 推进受击记忆：本 tick Core 受击则刷新到期 tick，否则保留原值（未过期时调用方
 *  传入 assessThreat 保持 ENGAGED）。纯函数，供 decide 入口维护跨 tick 状态。 */
export function advanceRecentAttack(
  tick: number,
  coreDamaged: boolean,
  prevUntilTick: number,
  memoryTicks: number = RECENT_ATTACK_MEMORY_TICKS,
): number {
  if (coreDamaged) return Math.max(prevUntilTick, tick + memoryTicks - 1);
  return prevUntilTick;
}

/** 45° 轴分桶：敌位置相对 Core 的角度 → 0..7（确定性：atan2 → round）。 */
function axisOf(core: Position, enemy: Position): number {
  const dx = enemy[0] - core[0];
  const dy = enemy[1] - core[1];
  if (dx === 0 && dy === 0) return 0;
  const angle = Math.atan2(dy, dx);
  return (Math.round(angle / (Math.PI / 4)) + 8) % 8;
}

function sameCell(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function manhattan(a: Position, b: Position): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

/** 与 nav.ts 同口径的格坐标 key（`x,y`），用于硬块集合查询。 */
function cellKey(cell: Position): string {
  return `${cell[0]},${cell[1]}`;
}

/** 竞品 multi-axis breakout 逃逸判定（第三十四轮对齐 + C5 硬块）：存在某方向
 *  使全部可见敌距离都增加（Manhattan，与竞品 _distance 同口径）= 有逃逸通道
 *  ——多轴但可逃不算 BREAKOUT。候选方向必须是可通行格：障碍格、资源格、敌占
 *  格为硬块（竞品 "Obstacles, resource terrain, enemy-occupied cells remain
 *  hard blocks"——旧判定裸四方向会把障碍格当成可逃方向）。 */
function hasEscapeDirection(
  core: Position,
  enemies: readonly VisibleEntity[],
  obstacles: ReadonlySet<string> = new Set(),
  resourceCells: ReadonlySet<string> = new Set(),
): boolean {
  const directions: ReadonlyArray<readonly [number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (const [dx, dy] of directions) {
    const destination: Position = [core[0] + dx, core[1] + dy];
    if (obstacles.has(cellKey(destination))) continue;
    if (resourceCells.has(cellKey(destination))) continue;
    if (enemies.some((enemy) => sameCell(enemy.position, destination))) continue;
    if (enemies.every((enemy) => manhattan(destination, enemy.position) > manhattan(core, enemy.position))) {
      return true;
    }
  }
  return false;
}

/** 竞品投影伤害（rule-correct）：Core 当前格是否被任一敌合法攻击覆盖——
 *  Vanguard 仅邻格（Chebyshev 1，SWEEP）；Ranger 八方向直线 ≤3 且中间格
 *  无障碍（SHOOT，lineBlocked）。C5 用"当前格投影伤害 >0"作为 BREAKOUT
 *  前提（旧判定用 12 格内——打不到的远处包围被高估为 BREAKOUT）。 */
export function projectedDamageOnCore(
  core: Position,
  enemies: readonly VisibleEntity[],
  obstacles: ReadonlySet<string>,
): number {
  let damage = 0;
  for (const enemy of enemies) {
    if (enemy.kind === "CORE") continue;
    const distance = Math.max(
      Math.abs(enemy.position[0] - core[0]),
      Math.abs(enemy.position[1] - core[1]),
    );
    if (enemy.unitType === "RANGER") {
      if (distance === 0 || distance > 3) continue;
      if (lineBlocked(core, enemy.position, obstacles)) continue;
      damage += 1;
    } else if (distance === 1) {
      damage += 1;
    }
  }
  return damage;
}

export function assessThreat(options: {
  readonly core: Position | null;
  readonly visibleEnemies: readonly VisibleEntity[];
  /** World.enemyHints()（含 prevPosition 差分信息）。 */
  readonly enemyHints: readonly EnemyMemory[];
  /** 本 tick 我方 Core 是否受击（仅 CORE_DAMAGED / CORE_DESTROYED）——
   *  ENGAGED 是 Core 级威胁；远程 worker 被摸不得升级为 Core 级
   *  （2026-08-07 竞品 recent_attack vs recent_core_attack 分账对齐）。 */
  readonly coreDamagedThisTick: boolean;
  /** 本 tick 我方战斗单位（Vanguard/Ranger）是否受击（UNIT_DAMAGED 且 actor 为
   *   我方战斗单位）——对齐竞品 local_squad_contact：前线接敌即升级 ENGAGED，
   *   即使核心未受击（t2 信标埋伏 1V+3R 被击杀实证：Vanguard 被围时威胁仍
   *   NORMAL，守军不增援）。 */
  readonly squadContactThisTick?: boolean;
  /** 障碍格（逃逸硬块；World.obstacles 合并视野障碍——默认空 = 无硬块）。 */
  readonly obstacles?: ReadonlySet<string>;
  /** 资源格（Core 不可入的逃逸硬块——默认空 = 无硬块）。 */
  readonly resourceCells?: ReadonlySet<string>;
  /** 近核入侵观察（2026-08-08，core-threat-watch-v1）：World.coreWatchTargets()
   *  长 TTL 近核敌情——当前不可见但曾在观察半径内目击的敌单位。用于把
   *  "盘踞/间歇可见"的近核敌情提升为 ALERT（短记忆 6 tick 会漏——t2 实证
   *  敌 WORKER 离核 2 格盘踞 600+ tick）。仅当本 tick 无可见敌时消费。 */
  readonly coreWatch?: readonly CoreWatchMemory[];
  /** 受击记忆到期 tick（decide 入口用 advanceRecentAttack 维护）：tick <= 该值
   *   且 tick>0 时，即使当前无可见敌也保持 ENGAGED（recent_attack_memory）。
   *   默认 0 = 未启用记忆。 */
  readonly recentAttackUntilTick?: number;
  /** 当前 tick（受击记忆过期判定用）。 */
  readonly tick?: number;
}): ThreatAssessment {
  const {
    core,
    visibleEnemies,
    enemyHints,
    coreDamagedThisTick,
    squadContactThisTick = false,
    obstacles = new Set<string>(),
    resourceCells = new Set<string>(),
    coreWatch = [],
    recentAttackUntilTick = 0,
    tick = 0,
  } = options;

  if (core === null) {
    return { level: "NORMAL", reason: "no_core", closingEnemies: 0, movingEnemies: 0, axes: 0, confirmedPursuit: false };
  }

  const hintsById = new Map(enemyHints.map((hint) => [hint.id, hint]));
  let movingEnemies = 0;
  let closingEnemies = 0;
  let confirmedPursuit = false;
  const axes = new Set<number>();

  for (const enemy of visibleEnemies) {
    const hint = hintsById.get(enemy.id);
    if (hint?.prevPosition !== undefined && !sameCell(hint.prevPosition, enemy.position)) {
      movingEnemies += 1;
    }
    const distance = Math.max(
      Math.abs(enemy.position[0] - core[0]),
      Math.abs(enemy.position[1] - core[1]),
    );
    if (distance <= THREAT_FALLBACK_RADIUS) closingEnemies += 1;
    // 确认追击（竞品 pursuit 对照）：积分 >0 且（12 格内 或 积分 ≥3 持续逼近）
    const pursuitScore = hint?.pursuitScore ?? 0;
    if (pursuitScore > 0 && (distance <= THREAT_FALLBACK_RADIUS || pursuitScore >= 3)) {
      confirmedPursuit = true;
    }
    axes.add(axisOf(core, enemy.position));
  }

  if (coreDamagedThisTick) {
    return { level: "ENGAGED", reason: "damaged", closingEnemies, movingEnemies, axes: axes.size, confirmedPursuit };
  }
  // 前线接敌（对齐竞品 local_squad_contact）：我方战斗单位本 tick 受击——
  // 即使核心未受击也升级 ENGAGED，触发守军增援/防御姿态（t2 信标埋伏被击杀
  // 实证：Vanguard 前线被围时威胁仍 NORMAL，后方不反应）。
  if (squadContactThisTick) {
    return {
      level: "ENGAGED",
      reason: "squad_contact",
      closingEnemies,
      movingEnemies,
      axes: axes.size,
      confirmedPursuit,
    };
  }
  // 受击记忆保持（对齐竞品 recent_core_attack）：Core 曾在记忆窗口内受击且未过期——
  // 即使当前无可见敌也保持 ENGAGED，防“打完就跑后立刻放松”（t3 丢局实证：受击后
  // 威胁随敌人消失即刻降级，守军撤离防空窗）。
  if (recentAttackUntilTick >= tick && tick > 0) {
    return {
      level: "ENGAGED",
      reason: "recent_attack_memory",
      closingEnemies,
      movingEnemies,
      axes: axes.size,
      confirmedPursuit,
    };
  }
  if (
    visibleEnemies.length >= 2 &&
    axes.size >= 2 &&
    projectedDamageOnCore(core, visibleEnemies, obstacles) > 0 &&
    !hasEscapeDirection(core, visibleEnemies, obstacles, resourceCells)
  ) {
    return { level: "BREAKOUT", reason: "multi_axis", closingEnemies, movingEnemies, axes: axes.size, confirmedPursuit };
  }
  if (confirmedPursuit) {
    return { level: "ALERT", reason: "pursuit", closingEnemies, movingEnemies, axes: axes.size, confirmedPursuit: true };
  }
  if (movingEnemies > 0 || closingEnemies > 0) {
    return {
      level: "ALERT",
      reason: movingEnemies > 0 ? "enemy_moving" : "enemy_near",
      closingEnemies,
      movingEnemies,
      axes: axes.size,
      confirmedPursuit,
    };
  }
  // 入侵观察（2026-08-08，core-threat-watch-v1）：长 TTL 近核观察内有敌战斗
  // 单位（Vanguard/Ranger，WORKER 无攻击不升级 Core 级威胁——由 Vanguard
  // 回访清剿处理）且当前不可见（按 id 排除——可见的走上方 closing/moving 路径，
  // 避免重复计数）——盘踞/间歇可见的敌方战斗单位威胁不随 6 tick 短记忆过期而
  // 消失（官方 guide：敌方战斗单位进入防区即回援）。
  const visibleIds = new Set(visibleEnemies.map((enemy) => enemy.id));
  const combatWatch = coreWatch.filter(
    (w) => w.kind === "UNIT" && w.unitType !== undefined && w.unitType !== "WORKER" && !visibleIds.has(w.id),
  );
  if (combatWatch.length > 0) {
    return {
      level: "ALERT",
      reason: "invasion_watch",
      closingEnemies: combatWatch.length,
      movingEnemies: 0,
      axes: 0,
      confirmedPursuit,
    };
  }
  return { level: "NORMAL", reason: null, closingEnemies: 0, movingEnemies: 0, axes: axes.size, confirmedPursuit: false };
}

/** 我方任意单位/Core 是否受击（从 resolution events 过滤——兼容旧调用）。 */
export function damagedThisTick(events: readonly { readonly eventType: string }[]): boolean {
  return events.some(
    (event) =>
      event.eventType === "CORE_DAMAGED" ||
      event.eventType === "UNIT_DAMAGED" ||
      event.eventType === "CORE_DESTROYED" ||
      event.eventType === "UNIT_DESTROYED",
  );
}

/** 我方 Core 是否受击（仅 CORE_DAMAGED / CORE_DESTROYED）——ENGAGED 判定
 *  用此函数：Core 级威胁与单位级受击分离（竞品 recent_core_attack 对照）。 */
/** 本 tick 我方战斗单位（Vanguard/Ranger）是否受击——local_squad_contact 判定：
 *  从 resolution events 过滤 UNIT_DAMAGED 且 actorId 属于我方战斗单位。
 *  WORKER 受击不升级 Core 级威胁（无攻击力的经济单位，由 Vanguard 清剿处理）。 */
export function squadContactThisTick(
  events: readonly { readonly eventType: string; readonly actorId: string | null }[],
  combatUnitIds: ReadonlySet<string>,
): boolean {
  return events.some(
    (event) =>
      event.eventType === "UNIT_DAMAGED" &&
      event.actorId !== null &&
      combatUnitIds.has(event.actorId),
  );
}

export function coreDamagedThisTick(events: readonly { readonly eventType: string }[]): boolean {
  return events.some(
    (event) =>
      event.eventType === "CORE_DAMAGED" ||
      event.eventType === "CORE_DESTROYED",
  );
}
