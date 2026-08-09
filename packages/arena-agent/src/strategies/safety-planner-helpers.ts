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

/**
 * 守卫外环守位（guard-spacing-v1，2026-08-09 用户裁决"守卫隔开拱卫，不
 * 堵死核心四邻"）：核心 4 邻格是核心移动通道 + worker 卸货通道——军事单位
 * 贴脸站位会堵死核心（迁移时核心无法行进、卸货时 deposit 死锁，t1 生产
 * 实证：守卫站核心行进方向前方格 → 引擎容量拒 → 迁移停滞）。守卫守位
 * 优先核心外环（Chebyshev 2-3，四角对角位优先），既保持拱卫距离（预警/
 * 拦截）又让出 4 邻通道；外环全堵才回退历史 homeCell 四邻（零回归兜底）。
 */
export function guardHomeCell(core: Position, obstacles: ReadonlySet<string>, index = 0): Position | null {
  const ringOrder: readonly Position[] = [
    [-2, -2], [2, -2], [-2, 2], [2, 2],
    [-2, 0], [2, 0], [0, -2], [0, 2],
    [-3, -3], [3, -3], [-3, 3], [3, 3],
    [-3, 0], [3, 0], [0, -3], [0, 3],
  ];
  for (let offset = 0; offset < ringOrder.length; offset += 1) {
    const [dx, dy] = ringOrder[(index + offset) % ringOrder.length]!;
    const cell: Position = [core[0] + dx, core[1] + dy];
    if (!obstacles.has(cellKey(cell))) return cell;
  }
  return homeCell(core, obstacles, index);
}

/**
 * W64 地形背靠守位（2026-08-09，竞品 arena_hero_strategy.py
 * `_core_attack_surface_profile` :2043 / `_terrain_guard_offsets` :2080 /
 * `_core_patrol_slots` :9303 对照）：守位选择时考虑地形背靠——从 Core 锚点
 * 沿 8 方向（RANGER_LINE_DELTAS）步进至 TERRAIN_GUARD_RAY_REACH，统计"开阔
 * 远程格"（每方向首个障碍前的 2..reach 格）总数与四轴（N/E/S/W）开阔半侧
 * 集中度。若位置"地形背靠"（open_axis 存在 + 开阔远程格总数 ≤ 上限 + 集中度
 * 达标），则将 Core 四邻守位按"开阔半侧优先"重排（守位站开阔侧、岩石在
 * 背后——背靠地形减少受击方向）；否则返回历史 homeCell 四邻轮转（零回归）。
 *
 * 与 guard-axes（B4）正交：guard-axes 按**威胁方向**（敌来路）分桶选守位轴，
 * W64 按**地形背靠**（岩石分布）重排四邻顺序——两者可叠加（guard-axes 在
 * 有可见敌时接管轴选位、W64 在无可见敌时接管四邻轮转顺序），维度不同
 * （threat vs terrain）。默认关闭（terrainGuard=false）= homeCell 历史行为。
 */
const TERRAIN_GUARD_RAY_REACH = 4;
/** 开阔远程格总数上限：超过 = 四面开阔（无背靠可言），不重排（历史行为）。 */
const TERRAIN_GUARD_MAX_OPEN_RANGED = 16;
/** 集中度门槛分子/分母（concentrated/open ≥ 该比例才算"背靠"——半侧集中
 *  足够多远程格时岩石才构成有效后盾）。对齐 ref MIGRATION_SITE_MIN_OPEN_HALF_RATIO。 */
const TERRAIN_GUARD_MIN_OPEN_HALF_NUMERATOR = 1;
const TERRAIN_GUARD_MIN_OPEN_HALF_DENOMINATOR = 2;

/** 8 方向单位向量（顺时针，y 向南）：E SE S SW W NW N NE。 */
const TERRAIN_GUARD_RAY_DELTAS: readonly Position[] = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];

/** 统计锚点的开阔远程格与最佳背靠轴（竞品 `_core_attack_surface_profile`）。
 *  返回 [openRangedCount, bestAxis, concentratedCount, meleeOpen]。 */
function coreAttackSurfaceProfile(
  anchor: Position,
  obstacles: ReadonlySet<string>,
): { openRanged: readonly Position[]; bestAxis: Position | null; concentrated: number; meleeOpen: number } {
  const openRanged: Position[] = [];
  let meleeOpen = 0;
  for (const [dx, dy] of TERRAIN_GUARD_RAY_DELTAS) {
    for (let distance = 1; distance <= TERRAIN_GUARD_RAY_REACH; distance += 1) {
      const cell: Position = [anchor[0] + dx * distance, anchor[1] + dy * distance];
      if (obstacles.has(cellKey(cell))) break;
      if (distance === 1) meleeOpen += 1;
      else openRanged.push([dx * distance, dy * distance]);
    }
  }
  let bestAxis: Position | null = null;
  let bestCount = -1;
  for (const axis of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const count = openRanged.reduce(
      (sum, offset) => sum + (offset[0] * axis[0] + offset[1] * axis[1] >= 0 ? 1 : 0),
      0,
    );
    if (count > bestCount) {
      bestAxis = [...axis] as Position;
      bestCount = count;
    }
  }
  return { openRanged, bestAxis, concentrated: Math.max(0, bestCount), meleeOpen };
}

/** W64 地形背靠守位：Core 四邻按"开阔半侧优先"重排后取第 index 个非障碍格。
 *  非地形背靠（四面开阔/集中度不足）= 回退 homeCell 历史四邻轮转（零回归）。 */
export function terrainGuardPost(
  core: Position,
  obstacles: ReadonlySet<string>,
  index = 0,
): Position | null {
  const { openRanged, bestAxis, concentrated } = coreAttackSurfaceProfile(core, obstacles);
  const order: readonly Direction[] = ["UP", "RIGHT", "DOWN", "LEFT"];
  const cellOf = (dir: Direction): Position =>
    dir === "UP" ? [core[0], core[1] - 1]
    : dir === "RIGHT" ? [core[0] + 1, core[1]]
    : dir === "DOWN" ? [core[0], core[1] + 1]
    : [core[0] - 1, core[1]];
  // 非地形背靠：回退历史四邻轮转（与 homeCell 同序——UP/RIGHT/DOWN/LEFT）。
  const notTerrainBacked =
    bestAxis === null
    || openRanged.length > TERRAIN_GUARD_MAX_OPEN_RANGED
    || concentrated * TERRAIN_GUARD_MIN_OPEN_HALF_DENOMINATOR
      < openRanged.length * TERRAIN_GUARD_MIN_OPEN_HALF_NUMERATOR;
  if (notTerrainBacked) return homeCell(core, obstacles, index);
  // 开阔半侧优先（offset·axis >= 0 = 与背靠轴同侧的远程格多 = 该侧开阔、
  // 另一侧有岩石背靠）。将四邻按"开阔半侧在前"重排，取第 index 个非障碍格。
  const [axisX, axisY] = bestAxis;
  const offsets: Direction[] = [...order];
  const openHalf = offsets.filter((dir) => {
    const cell = cellOf(dir);
    return (cell[0] - core[0]) * axisX + (cell[1] - core[1]) * axisY >= 0;
  });
  const blockedHalf = offsets.filter((dir) => !openHalf.includes(dir));
  const reordered = [...openHalf, ...blockedHalf];
  for (let offset = 0; offset < reordered.length; offset += 1) {
    const dir = reordered[(index + offset) % reordered.length];
    const cell = cellOf(dir);
    if (!obstacles.has(cellKey(cell))) return cell;
  }
  return null;
}

/** W55 单入口掩体入口（竞品 `_shelter_entrance` :2297）：四邻中恰有一个
 *  开放（三面被障碍包围的口袋）→ 返回该唯一开放邻格；否则返回 null
 *  （0 开放 = 死格、≥2 开放 = 非掩体）。 */
function shelterEntrance(
  position: Position,
  obstacles: ReadonlySet<string>,
): Position | null {
  const neighbors: Position[] = [];
  for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
    const cell: Position = [position[0] + dx, position[1] + dy];
    if (!obstacles.has(cellKey(cell))) neighbors.push(cell);
  }
  return neighbors.length === 1 ? neighbors[0]! : null;
}

/**
 * W55 单入口掩体寻找（2026-08-09，竞品 arena_hero_strategy.py
 * `_find_core_shelter` :9388 对照）：在 Core 的 searchRadius（Chebyshev）
 * 范围内寻找单入口掩体（四邻恰一开放 = 三面岩石口袋）作为迁移目标——
 * 背靠地形防守（仅一方向需布防，raid 难以多轴夹击）。
 *
 * 选择顺序（竞品 score 字典序）：距 Core 越近越优（迁移路径短、风险小）。
 * 候选必须：非障碍/非资源格、自身是掩体（shelterEntrance 非空）、入口
 * 非障碍/非资源。返回 [target, entrance]；无候选返回 null（调用方不迁移）。
 *
 * 与 coreEvade 正交：coreEvade 是"敌逼近时远敌"反应式迁移，W55 是"无威胁
 * 时抢占地形"主动式迁移。与 chokepointLockPoint 不同：chokepoint 找敌核
 * 邻格锁点（封锁敌回程），W55 找我核迁移掩体（地形防守）。
 */
export function coreShelterTarget(
  core: Position,
  obstacles: ReadonlySet<string>,
  resourceCells: ReadonlySet<string>,
  searchRadius = 8,
): { target: Position; entrance: Position } | null {
  let best: { target: Position; entrance: Position; distance: number } | null = null;
  for (let dx = -searchRadius; dx <= searchRadius; dx += 1) {
    for (let dy = -searchRadius; dy <= searchRadius; dy += 1) {
      if (Math.abs(dx) > searchRadius || Math.abs(dy) > searchRadius) continue;
      if (Math.abs(dx) + Math.abs(dy) === 0) continue; // 跳过 Core 自身（调用方单独判定 hold）
      const candidate: Position = [core[0] + dx, core[1] + dy];
      const candidateKey = cellKey(candidate);
      if (obstacles.has(candidateKey)) continue;
      if (resourceCells.has(candidateKey)) continue;
      const entrance = shelterEntrance(candidate, obstacles);
      if (entrance === null) continue;
      const entranceKey = cellKey(entrance);
      if (obstacles.has(entranceKey)) continue;
      if (resourceCells.has(entranceKey)) continue;
      const distance = Math.abs(dx) + Math.abs(dy);
      if (
        best === null
        || distance < best.distance
        || (distance === best.distance
          && (candidate[0] < best.target[0]
            || (candidate[0] === best.target[0] && candidate[1] < best.target[1])))
      ) {
        best = { target: candidate, entrance, distance };
      }
    }
  }
  return best === null ? null : { target: best.target, entrance: best.entrance };
}

/** 当前 Core 位置是否本身已是掩体（hold 判定用）。 */
export function isCoreShelter(core: Position, obstacles: ReadonlySet<string>): Position | null {
  return shelterEntrance(core, obstacles);
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

/** 游侠风筝位（ranger-kite-v1，2026-08-08，用户导向"打了就跑"）：aggressive Ranger
 *  近身（Chebyshev 1）遇 VANGUARD 近战威胁时，从 8 方向候选格中选一个"距威胁
 *  Chebyshev 2-3、可射击威胁（下 tick 能开火）、非障碍/非敌占/容量 <2"的格子；
 *  多个候选取"距最近敌最远 + 坐标字典序"（确定性）。返回 null = 无合法风筝位
 *  （调用方原地射击）。纯函数可测。 */
export function kiteCell(
  from: Position,
  threat: Position,
  obstacles: ReadonlySet<string>,
  occupancy: ReadonlyMap<string, number>,
  enemies: readonly VisibleEntity[],
): Position | null {
  const deltas: readonly Position[] = [
    [1, 0], [1, 1], [0, 1], [-1, 1],
    [-1, 0], [-1, -1], [0, -1], [1, -1],
  ];
  let best: Position | null = null;
  let bestMinDist = Number.NEGATIVE_INFINITY;
  for (const [dx, dy] of deltas) {
    const cand: Position = [from[0] + dx, from[1] + dy];
    if (obstacles.has(cellKey(cand))) continue;
    if (enemies.some((enemy) => samePosition(enemy.position, cand))) continue;
    if ((occupancy.get(cellKey(cand)) ?? 0) >= 2) continue;
    const distToThreat = chebyshev(cand, threat);
    if (distToThreat < 2 || distToThreat > 3) continue;
    if (!canShoot(cand, threat, obstacles)) continue;
    const minEnemyDist = Math.min(
      distToThreat,
      ...enemies.map((enemy) => manhattan(cand, enemy.position)),
    );
    const better =
      minEnemyDist > bestMinDist ||
      (minEnemyDist === bestMinDist &&
        (best === null ||
          cand[0] < best[0] ||
          (cand[0] === best[0] && cand[1] < best[1])));
    if (better) {
      bestMinDist = minEnemyDist;
      best = cand;
    }
  }
  return best;
}
