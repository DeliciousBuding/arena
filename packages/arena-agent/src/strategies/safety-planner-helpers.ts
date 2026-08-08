import {
  cellKey,
  type Direction,
  type Position,
  type TickState,
  type UnitType,
  type VisibleEntity,
} from "../domain/model.ts";
import { chebyshev, lineBlocked, manhattan } from "../domain/nav.ts";
import type { SafetyPlannerConfig } from "./safety-planner-config.ts";

export function nextSpawn(state: TickState, workerTarget: number, config: SafetyPlannerConfig): UnitType {
  if (state.workers.length < workerTarget) return "WORKER";
  return nextMilitary(state, config);
}

export function nextMilitary(state: TickState, config: SafetyPlannerConfig): UnitType {
  const ratio = config.vanguardRatio;
  if (ratio === undefined) {
    return state.vanguards.length <= state.rangers.length ? "VANGUARD" : "RANGER";
  }
  const military = state.vanguards.length + state.rangers.length;
  // ceil((military+1)*ratio)：新兵计入后 VANGUARD 占比不超过 ratio 才产 VANGUARD。
  // （floor(military*ratio) 在 military=0 时恒 0——ratio=1 也错误产 RANGER。）
  const targetVanguards = Math.ceil((military + 1) * ratio);
  return state.vanguards.length < targetVanguards ? "VANGUARD" : "RANGER";
}

/** Core 的守家锚点：四邻中第一个非障碍格（确定性 UP→RIGHT→DOWN→LEFT）。
 *  军事单位守家站此格而非 Core 格本身——Core 格是 Worker 回仓通道，
 *  被长期占用会造成 capacity_wait:DEPOSIT 经济死锁。 */
/** 防御轴分桶守卫轮转（B4 竞品 defense distribution 对照，2026-08-07）：
 *  可见战斗敌按相对 Core 的主接近方向分 4 轴桶（N/E/S/W）；威胁轴按"轴内
 *  最近敌距离升序"排序（威胁大的轴先被覆盖），第 i 个防守者取排序后第
 *  (i % 轴数) 轴的外层守位——守卫按轴分散而非全部挤向最近敌方向。
 *  守位半径：Vanguard 3（外层屏）/ Ranger 2（内层屏，竞品
 *  VANGUARD_GUARD_RADIUS=3 / RANGER_GUARD_RADIUS=2）。保持 Core 邻格为空
 *  （cargo 通道）——半径 ≥2 天然满足；守位被障碍/敌占占用时沿轴向内收缩
 *  （radius-1 直到 1），全堵返回 null（调用方回退 homeCell 历史四邻轮转）。 */
const VANGUARD_GUARD_RADIUS = 3;
const RANGER_GUARD_RADIUS = 2;

/** 敌相对 Core 的主接近方向轴（4 桶，确定性：|dx| 与 |dy| 比较）。 */
type ThreatAxis = "N" | "E" | "S" | "W";

function axisOfDelta(dx: number, dy: number): ThreatAxis {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "E" : "W";
  return dy >= 0 ? "S" : "N";
}

const AXIS_DIRECTIONS: Readonly<Record<ThreatAxis, Position>> = Object.freeze({
  N: [0, -1],
  E: [1, 0],
  S: [0, 1],
  W: [-1, 0],
});
const AXIS_ORDER: readonly ThreatAxis[] = ["N", "E", "S", "W"];

export function defensePost(
  core: Position,
  enemies: readonly VisibleEntity[],
  obstacles: ReadonlySet<string>,
  unitType: "VANGUARD" | "RANGER",
  index: number,
): Position | null {
  // 每轴最近敌距离（无可见敌在该轴 = Infinity → 该轴不参与）
  const axisMinDistance: Record<ThreatAxis, number> = {
    N: Number.POSITIVE_INFINITY,
    E: Number.POSITIVE_INFINITY,
    S: Number.POSITIVE_INFINITY,
    W: Number.POSITIVE_INFINITY,
  };
  for (const enemy of enemies) {
    if (enemy.kind === "CORE") continue;
    const axis = axisOfDelta(enemy.position[0] - core[0], enemy.position[1] - core[1]);
    axisMinDistance[axis] = Math.min(
      axisMinDistance[axis],
      manhattan(core, enemy.position),
    );
  }
  const axesWithEnemies = AXIS_ORDER
    .filter((axis) => Number.isFinite(axisMinDistance[axis]))
    .sort(
      (a, b) =>
        axisMinDistance[a] - axisMinDistance[b] ||
        AXIS_ORDER.indexOf(a) - AXIS_ORDER.indexOf(b),
    );
  if (axesWithEnemies.length === 0) return null;
  const axis = axesWithEnemies[index % axesWithEnemies.length];
  const radius = unitType === "VANGUARD" ? VANGUARD_GUARD_RADIUS : RANGER_GUARD_RADIUS;
  // 沿轴由外向内收缩：守位被障碍/敌占占用时向内一格（半径 ≥2 保持 Core 邻格空）
  for (let r = radius; r >= 1; r -= 1) {
    const candidate: Position = [
      core[0] + AXIS_DIRECTIONS[axis][0] * r,
      core[1] + AXIS_DIRECTIONS[axis][1] * r,
    ];
    if (obstacles.has(cellKey(candidate))) continue;
    if (enemies.some((enemy) => samePosition(enemy.position, candidate))) continue;
    return candidate;
  }
  return null;
}

/**
 * 让位锚点（2026-08-07，生产 t2 实证修复）：已在 Core 格的军事单位
 * （Ranger/Vanguard）移出回仓通道的目标格。与 homeCell 不同，让位必须
 * 避开被单位占用的格——Core 四邻全堵（障碍 + 单位）时 homeCell 会选到
 * 满格（如 t2：[-53,49] 被 Vanguard+worker 占 2）→ 预裁决按容量淘汰
 * 让位动作 → Ranger 永不离开 → worker 永不 deposit → 经济死锁。
 * 选择顺序：① 空邻格（占用 0，最优先）；② 单占用邻格（占用 1——
 * 可挤入，容量 2，预裁决按优先级裁决）；③ 全堵返回 null（原地等，
 * 下一 tick 重试）。
 */
export function yieldAnchor(
  core: Position,
  obstacles: ReadonlySet<string>,
  occupancy: ReadonlyMap<string, number>,
  enemies: readonly VisibleEntity[] = [],
): Position | null {
  const order: readonly Direction[] = ["UP", "RIGHT", "DOWN", "LEFT"];
  const cellOf = (target: Direction): Position => target === "UP"
    ? [core[0], core[1] - 1]
    : target === "RIGHT"
      ? [core[0] + 1, core[1]]
      : target === "DOWN"
        ? [core[0], core[1] + 1]
        : [core[0] - 1, core[1]];
  // 候选：先空位（占用 0），无空位再单占用（可挤入容量 2）。
  const candidates: Position[] = [];
  for (const pass of [0, 1]) {
    for (const target of order) {
      const cell = cellOf(target);
      if (obstacles.has(cellKey(cell))) continue;
      if ((occupancy.get(cellKey(cell)) ?? 0) === pass) candidates.push(cell);
    }
    if (candidates.length > 0) break;
  }
  if (candidates.length === 0) return null;
  if (enemies.length === 0) return candidates[0];
  // 可见敌人时：让位目标优先远离敌人（官方 arena_farmer egress 同语义——
  // 守卫让位不走进敌人怀里；防御性增强）。敌人距离相同保持确定性原序。
  candidates.sort((left, right) => {
    const leftDistance = nearestEnemyDistance(left, enemies);
    const rightDistance = nearestEnemyDistance(right, enemies);
    if (leftDistance !== rightDistance) return rightDistance - leftDistance;
    const leftDirection = directionOf(core, left, order);
    const rightDirection = directionOf(core, right, order);
    return leftDirection - rightDirection;
  });
  return candidates[0];
}

/** 到最近可见敌人的 Manhattan 距离（让位目标排序用）。 */
function nearestEnemyDistance(cell: Position, enemies: readonly VisibleEntity[]): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const enemy of enemies) {
    nearest = Math.min(nearest, manhattan(cell, enemy.position));
  }
  return nearest;
}

/** cell 相对 core 的方向序（UP=0 RIGHT=1 DOWN=2 LEFT=3，确定性平局序）。 */
function directionOf(core: Position, cell: Position, order: readonly Direction[]): number {
  for (let index = 0; index < order.length; index += 1) {
    const target = order[index];
    const delta: Position = target === "UP"
      ? [0, -1]
      : target === "RIGHT"
        ? [1, 0]
        : target === "DOWN"
          ? [0, 1]
          : [-1, 0];
    if (cell[0] === core[0] + delta[0] && cell[1] === core[1] + delta[1]) return index;
  }
  return Number.MAX_SAFE_INTEGER;
}

/** 当前占用计数（Core + 全部单位），让位锚点判断"空位/单占用"用。 */
export function occupancyCounts(state: TickState): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (position: Position): void => {
    const key = cellKey(position);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  if (state.core !== null) bump(state.core.position);
  for (const unit of state.units) bump(unit.position);
  return counts;
}

export function homeCell(core: Position, obstacles: ReadonlySet<string>, index = 0): Position | null {
  const order: readonly Direction[] = ["UP", "RIGHT", "DOWN", "LEFT"];
  for (let offset = 0; offset < order.length; offset += 1) {
    const dir = order[(index + offset) % order.length];
    const cell: Position = dir === "UP"
      ? [core[0], core[1] - 1]
      : dir === "RIGHT"
        ? [core[0] + 1, core[1]]
        : dir === "DOWN"
          ? [core[0], core[1] + 1]
          : [core[0] - 1, core[1]];
    if (!obstacles.has(cellKey(cell))) return cell;
  }
  return null;
}

export function nearestEnemy(enemies: readonly VisibleEntity[], position: Position): VisibleEntity | null {
  return [...enemies].sort(
    (a, b) => manhattan(position, a.position) - manhattan(position, b.position) || a.id.localeCompare(b.id),
  )[0] ?? null;
}

/** Core 迁移方向（coreEvade，PRE_EVADE-lite）：4 方向候选中，硬块（障碍/资源/
 *  敌占格）排除；评分 = 最近敌距离（越大越好，无敌人 = 无穷）×1000 + beacon 距离
 *  （远离敌人优先、次远离 beacon——竞品 retreat 语义的确定性简化版）。
 *  coreEvadeScoring=true 时用多目标字典序（竞品 threat-response 对照）：
 *  投影伤害（候选格受敌射程内伤害总值，Vanguard sweep 1 格 / Ranger 直线 3 格）
 *  → 全敌距离升序向量字典序（远离所有敌，不只最近）→ beacon 距离（小优）。
 *  修复：旧评分只取 minEnemyDistance，退向"离最近敌最远"的方向可能冲进
 *  另一敌的射程（Ranger 3 格直线）。 */
const RANGER_SHOOT_RANGE = 3;

/** 竞品投影伤害（rule-correct）：敌当前格可对候选格发动的合法攻击——
 *  Vanguard 仅卡向邻格（Manhattan 1，SWEEP 方向枚举只有四向，对角不可扫）；
 *  Ranger 八方向直线 ≤3 且中间格无障碍（SHOOT，lineBlocked）。旧实现用
 *  Manhattan ≤ range 代理：把 (2,1) 非法线算 1 伤、无视障碍遮挡
 *  （2026-08-07 C6 对齐）。 */
function projectedDamageAt(
  target: Position,
  enemy: VisibleEntity,
  obstacles: ReadonlySet<string>,
): number {
  if (enemy.kind === "CORE") return 0;
  if (enemy.unitType === "RANGER") {
    const distance = chebyshev(target, enemy.position);
    if (distance === 0 || distance > RANGER_SHOOT_RANGE) return 0;
    return lineBlocked(target, enemy.position, obstacles) ? 0 : 1;
  }
  // VANGUARD / WORKER 近战：SWEEP 无斜向——只有卡向邻格可伤害，对角邻格
  // 当前打不到（2026-08-08 与米字修复同源：四方向语义不按八方向估算）。
  return manhattan(target, enemy.position) === 1 ? 1 : 0;
}

export function retreatDirection(
  core: Position,
  enemies: readonly VisibleEntity[],
  obstacles: ReadonlySet<string>,
  beacon: Position,
  scoring: "distance" | "multi" = "distance",
): Direction | null {
  const candidates: readonly Direction[] = ["UP", "RIGHT", "DOWN", "LEFT"];
  let best: Direction | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestVector: readonly number[] = [];
  let bestBeacon = 0;
  for (const direction of candidates) {
    const destination: Position =
      direction === "UP"
        ? [core[0], core[1] - 1]
        : direction === "RIGHT"
          ? [core[0] + 1, core[1]]
          : direction === "DOWN"
            ? [core[0], core[1] + 1]
            : [core[0] - 1, core[1]];
    if (obstacles.has(cellKey(destination))) continue;
    if (enemies.some((enemy) => samePosition(enemy.position, destination))) continue;
    if (scoring === "distance") {
      const minEnemyDistance =
        enemies.length === 0
          ? Number.POSITIVE_INFINITY
          : Math.min(...enemies.map((enemy) => manhattan(destination, enemy.position)));
      const score = minEnemyDistance * 1000 + manhattan(destination, beacon);
      if (score > bestScore) {
        bestScore = score;
        best = direction;
      }
      continue;
    }
    // 多目标评分（coreEvadeScoring）：投影伤害 → 全敌距离升序向量 → beacon。
    const projectedDamage = enemies.reduce((sum, enemy) => {
      return sum + projectedDamageAt(destination, enemy, obstacles);
    }, 0);
    const distanceVector = enemies
      .map((enemy) => manhattan(destination, enemy.position))
      .sort((a, b) => a - b);
    const beaconDistance = manhattan(destination, beacon);
    // 字典序：投影伤害小优 → 敌距向量大优 → beacon 小优。
    if (
      best === null ||
      compareRetreat(projectedDamage, distanceVector, beaconDistance, bestScore, bestVector, bestBeacon) > 0
    ) {
      bestScore = projectedDamage;
      bestVector = distanceVector;
      bestBeacon = beaconDistance;
      best = direction;
    }
  }
  return best;
}

/** 多目标字典序比较（竞品 retreat 语义）：投影伤害（小优）→ 全敌距离升序向量
 *  （大优）→ beacon 距离（小优）。返回 >0 表示 candidate 优于 incumbent。 */
function compareRetreat(
  candidateDamage: number,
  candidateVector: readonly number[],
  candidateBeacon: number,
  incumbentDamage: number,
  incumbentVector: readonly number[],
  incumbentBeacon: number,
): number {
  if (candidateDamage !== incumbentDamage) return incumbentDamage - candidateDamage;
  const length = Math.max(candidateVector.length, incumbentVector.length);
  for (let index = 0; index < length; index += 1) {
    const a = candidateVector[index] ?? 0;
    const b = incumbentVector[index] ?? 0;
    if (a !== b) return a - b;
  }
  return incumbentBeacon - candidateBeacon;
}

/** 激进射击目标优先级：断敌经济（WORKER）优先，其次远程单位，最后 Core。
 *  排序稳定：同优先级按 raw id 字典序（nearestEnemy 的调用方约束）。 */
/** 激进射击目标优先级（纯类型价值）：断敌经济（WORKER 优先），同价值 raw id 序。 */
export function aggressiveShotPriority(a: VisibleEntity, b: VisibleEntity): number {
  return shotTargetRank(a) - shotTargetRank(b) || a.id.localeCompare(b.id);
}

/** 防守射击目标优先级：最近威胁优先（1 格外的 Vanguard 即将 sweep 我们），
 *  同距离再按威胁价值（RANGER 优先——远程火力 3 格持续威胁；再 VANGUARD 近战；
 *  WORKER 最后——不构成即时威胁，断经济是进攻姿态的事，2026-08-06 竞品
 *  hierarchical threat assessment 对照），最后 raw id 序（确定性）。 */
export function defensiveShotPriority(from: Position, a: VisibleEntity, b: VisibleEntity): number {
  return (
    manhattan(from, a.position) - manhattan(from, b.position) ||
    defensiveShotTargetRank(a) - defensiveShotTargetRank(b) ||
    a.id.localeCompare(b.id)
  );
}

/** 防守威胁价值（低 = 优先）：RANGER 远程持续威胁 > VANGUARD 近战 > WORKER 无即时威胁。 */
function defensiveShotTargetRank(enemy: VisibleEntity): number {
  if (enemy.kind === "CORE") return 3;
  return enemy.unitType === "RANGER" ? 0 : enemy.unitType === "VANGUARD" ? 1 : 2;
}

/** 进攻目标价值（低 = 优先）：断敌经济（WORKER 优先），同价值 raw id 序。 */
function shotTargetRank(enemy: VisibleEntity): number {
  if (enemy.kind === "CORE") return 3;
  return enemy.unitType === "WORKER" ? 0 : enemy.unitType === "RANGER" ? 1 : 2;
}

export function canShoot(from: Position, target: Position, obstacles: ReadonlySet<string>): boolean {
  const dx = target[0] - from[0];
  const dy = target[1] - from[1];
  const distance = Math.max(Math.abs(dx), Math.abs(dy));
  return distance >= 1 &&
    distance <= 3 &&
    (dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy)) &&
    !lineBlocked(from, target, obstacles);
}

/** 预测敌人下一 Tick 位置：朝攻击者沿主导轴逼近一格（四方向卡向步进，
 *  与官方移动规则一致——移动只有 UP/DOWN/LEFT/RIGHT，无斜向，敌人每 tick
 *  最多走一格）。仅当敌人当前不在射程内时用于 cell fire 预判；已在射程内
 *  由 precision shoot 覆盖。返回 null 表示无法预测（与攻击者同格）。
 *  斜向（|dx|==|dy|）时确定性选 x 轴；调用方 canShoot 会过滤非射击线
 *  预测格——斜向敌人一步无法进入可射击格（其四方向步进的落点都在线外），
 *  于是不预判开火，杜绝"射空气"空枪。 */
export function predictedEnemyCell(actor: Position, enemy: Position): Position | null {
  const dx = enemy[0] - actor[0];
  const dy = enemy[1] - actor[1];
  if (dx === 0 && dy === 0) return null;
  // 敌人只沿主轴走一步（|dx|>=|dy| 走 x，否则走 y——与 axisOfDelta 同口径）。
  if (Math.abs(dx) >= Math.abs(dy)) {
    return [enemy[0] - Math.sign(dx), enemy[1]];
  }
  return [enemy[0], enemy[1] - Math.sign(dy)];
}

export function parseCell(value: string): Position {
  const [x, y] = value.split(",").map(Number);
  return [x, y];
}

export function samePosition(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

export function directionName(direction: Direction): Direction {
  return direction;
}
