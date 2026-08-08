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
 *  Vanguard 仅卡向邻格（Manhattan 1，SWEEP 方向枚举只有四向，对角不可扫）；
 *  Ranger 八方向直线 ≤3 且中间格无障碍（SHOOT，lineBlocked）。C5 用
 *  "当前格投影伤害 >0"作为 BREAKOUT 前提（旧判定用 12 格内——打不到的
 *  远处包围被高估为 BREAKOUT）。 */
export function projectedDamageOnCore(
  core: Position,
  enemies: readonly VisibleEntity[],
  obstacles: ReadonlySet<string>,
): number {
  let damage = 0;
  for (const enemy of enemies) {
    if (enemy.kind === "CORE") continue;
    if (enemy.unitType === "RANGER") {
      const distance = Math.max(
        Math.abs(enemy.position[0] - core[0]),
        Math.abs(enemy.position[1] - core[1]),
      );
      if (distance === 0 || distance > 3) continue;
      if (lineBlocked(core, enemy.position, obstacles)) continue;
      damage += 1;
    } else if (manhattan(core, enemy.position) === 1) {
      // 对角邻格 Vanguard 当前打不到 Core（SWEEP 无斜向）——与米字修复
      // 同源（2026-08-08）：四方向语义不按八方向估算。
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
  /** 障碍格（逃逸硬块；World.obstacles 合并视野障碍——默认空 = 无硬块）。 */
  readonly obstacles?: ReadonlySet<string>;
  /** 资源格（Core 不可入的逃逸硬块——默认空 = 无硬块）。 */
  readonly resourceCells?: ReadonlySet<string>;
  /** 近核入侵观察（2026-08-08，core-threat-watch-v1）：World.coreWatchTargets()
   *  长 TTL 近核敌情——当前不可见但曾在观察半径内目击的敌单位。用于把
   *  "盘踞/间歇可见"的近核敌情提升为 ALERT（短记忆 6 tick 会漏——t2 实证
   *  敌 WORKER 离核 2 格盘踞 600+ tick）。仅当本 tick 无可见敌时消费。 */
  readonly coreWatch?: readonly CoreWatchMemory[];
}): ThreatAssessment {
  const {
    core,
    visibleEnemies,
    enemyHints,
    coreDamagedThisTick,
    obstacles = new Set<string>(),
    resourceCells = new Set<string>(),
    coreWatch = [],
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
export function coreDamagedThisTick(events: readonly { readonly eventType: string }[]): boolean {
  return events.some(
    (event) =>
      event.eventType === "CORE_DAMAGED" ||
      event.eventType === "CORE_DESTROYED",
  );
}
