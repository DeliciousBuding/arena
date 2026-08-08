import { cellKey, type Direction, type Position } from "./model.ts";

const DIRECTION_ORDER: readonly Direction[] = ["RIGHT", "DOWN", "LEFT", "UP"];
export const EXPLORE_DIRECTION_COUNT = 8;
/** 巡逻探索环数：半径 × (1..EXPLORE_RING_COUNT)。
 *  4 → 覆盖 8/16/24/32 格；5 → 覆盖 8/16/24/32/40 格（2026-08-06 生产实证：
 *  t1 资源枯竭时矿在 Core 40 格外，4 环巡逻永远测绘不到——40 格矿只有
 *  5 环巡逻（环半径 40 + 视野 5）才能进入视野记忆）。 */
export const EXPLORE_RING_COUNT = 5;
/** 顺时针 8 方位：东、东南、南、西南、西、西北、北、东北。 */
const EXPLORE_DELTAS: readonly Position[] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];
const DELTA: Readonly<Record<Direction, Position>> = {
  UP: [0, -1],
  DOWN: [0, 1],
  LEFT: [-1, 0],
  RIGHT: [1, 0],
};

export function manhattan(a: Position, b: Position): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

export function chebyshev(a: Position, b: Position): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
}

/** 分层扩圈：base、2×base、3×base、4×base，然后循环回内圈。 */
export function exploreRadiusForRing(baseRadius: number, ringIndex: number): number {
  if (!Number.isInteger(baseRadius) || baseRadius < 1) {
    throw new Error(`baseRadius must be a positive integer: ${String(baseRadius)}`);
  }
  const normalized = ((ringIndex % EXPLORE_RING_COUNT) + EXPLORE_RING_COUNT) % EXPLORE_RING_COUNT;
  return baseRadius * (normalized + 1);
}

export function lineBlocked(a: Position, b: Position, obstacles: ReadonlySet<string>): boolean {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (steps <= 1) return false;
  const sx = dx === 0 ? 0 : dx / steps;
  const sy = dy === 0 ? 0 : dy / steps;
  if (!Number.isInteger(sx) || !Number.isInteger(sy)) return true;
  for (let i = 1; i < steps; i += 1) {
    if (obstacles.has(cellKey([a[0] + sx * i, a[1] + sy * i]))) {
      return true;
    }
  }
  return false;
}

/** 半径受限确定性 BFS 的搜索参数（生产实测：满载 Worker 回仓路线被敌方
 *  单位群挡路时，旧扩框 BFS 要么走出包围盒、要么给出必被容量拒绝的 MOVE。
 *  新 BFS 在有限半径内找最短路并输出第一步，绕行是局部的（走廊宽度量级）。 */
export interface PathSearchOptions {
  /** 展开节点上限（含起点）。默认 4096（> 半径 24 的 2401 格覆盖，安全网）。 */
  readonly nodeBudget: number;
  /** Chebyshev 搜索半径（不依赖地图边界，负坐标天然支持）。默认 24。 */
  readonly searchRadius: number;
  /** 距离增长剪枝：g + h > 直线距 × factor 即放弃该分支（绕行 > 2× 直线距
   *  的通道已实质封死，WAIT 等敌群散开比绕 60+ tick 更优）。默认 3。 */
  readonly abandonFactor: number;
}

export const DEFAULT_PATH_SEARCH_OPTIONS: Readonly<PathSearchOptions> = Object.freeze({
  nodeBudget: 4096,
  searchRadius: 24,
  abandonFactor: 3,
});

/** 远距离目标的 BFS 参数自适应：distance 超过默认半径时放大搜索半径，
 *  保证远处资源点/回仓目标在搜索窗内（生产实测：满载 Worker 在 40+ 格外
 *  回仓时，默认 radius 24 搜索窗直接不可达，退化为 fail-safe 卡死）。 */
export function adaptivePathOptions(distance: number): PathSearchOptions {
  if (distance <= DEFAULT_PATH_SEARCH_OPTIONS.searchRadius) return DEFAULT_PATH_SEARCH_OPTIONS;
  const searchRadius = Math.min(64, distance + 2);
  return {
    nodeBudget: (2 * searchRadius + 1) ** 2, // 全盒覆盖（(2r+1)²）：旧 4r² 少 4r+1 格，超 24 格斜线目标跑不满预算即 null（2026-08-08 t4 深探实证）
    searchRadius,
    abandonFactor: DEFAULT_PATH_SEARCH_OPTIONS.abandonFactor,
  };
}

interface SearchNode {
  readonly position: Position;
  readonly firstDirection: Direction | null;
  readonly depth: number;
}

/** 半径受限确定性 BFS：返回从 start 到 target 最短路的第一步方向。
 *  确定性（邻居按 orderedDirections 固定顺序展开、FIFO 首达即最优）、
 *  无状态（不缓存路径）、不走进 obstacles（含敌方格）。预算/半径内不可达
 *  返回 null，调用方回退到旧扩框 BFS 与 fail-safe。 */
export function stepTowardPath(
  start: Position,
  target: Position,
  obstacles: ReadonlySet<string>,
  options: PathSearchOptions = DEFAULT_PATH_SEARCH_OPTIONS,
): Direction | null {
  if (start[0] === target[0] && start[1] === target[1]) return null;
  if (obstacles.has(cellKey(target))) return null;

  const directDistance = manhattan(start, target);
  const abandonAt = directDistance * options.abandonFactor;
  const queue: SearchNode[] = [{ position: start, firstDirection: null, depth: 0 }];
  const visited = new Set<string>([cellKey(start)]);
  let head = 0;

  while (head < queue.length && head < options.nodeBudget) {
    const node = queue[head++];
    for (const direction of orderedDirections(node.position, target)) {
      const next = move(node.position, direction);
      if (chebyshev(start, next) > options.searchRadius) continue;
      const key = cellKey(next);
      if (visited.has(key) || obstacles.has(key)) continue;
      const depth = node.depth + 1;
      if (depth + manhattan(next, target) > abandonAt) continue;
      const firstDirection = node.firstDirection ?? direction;
      if (next[0] === target[0] && next[1] === target[1]) return firstDirection;
      visited.add(key);
      queue.push({ position: next, firstDirection, depth });
    }
  }
  return null;
}

/** 多目标障碍感知最短路距离场（确定性 BFS）。
 *
 * 用于任务分配代价，而不是动作执行：一次从 start 展开即可同时得到多个目标的
 * shortest-path distance，避免 Worker×Resource 每一对都各跑一次 BFS。目标未在
 * 搜索预算/半径内找到时不返回该 key，调用方可按“未知路径”降级而不是误判永久不可达。 */
export function shortestPathDistances(
  start: Position,
  targets: readonly Position[],
  obstacles: ReadonlySet<string>,
  options?: PathSearchOptions,
): ReadonlyMap<string, number> {
  const targetKeys = new Set(targets.map((target) => cellKey(target)));
  const result = new Map<string, number>();
  if (targetKeys.size === 0) return result;
  const startKey = cellKey(start);
  if (targetKeys.has(startKey)) result.set(startKey, 0);
  if (result.size === targetKeys.size) return result;

  const maxDirect = Math.max(
    1,
    ...targets.map((target) => manhattan(start, target)),
  );
  const search = options ?? adaptivePathOptions(maxDirect);
  const queue: Array<{ position: Position; depth: number }> = [{ position: start, depth: 0 }];
  const visited = new Set<string>([startKey]);
  let head = 0;
  while (head < queue.length && head < search.nodeBudget) {
    const current = queue[head++]!;
    for (const direction of DIRECTION_ORDER) {
      const next = move(current.position, direction);
      if (chebyshev(start, next) > search.searchRadius) continue;
      const key = cellKey(next);
      if (visited.has(key) || obstacles.has(key)) continue;
      visited.add(key);
      const depth = current.depth + 1;
      if (targetKeys.has(key)) {
        result.set(key, depth);
        if (result.size === targetKeys.size) return result;
      }
      queue.push({ position: next, depth });
    }
  }
  return result;
}

export function stepToward(
  position: Position,
  target: Position,
  obstacles: ReadonlySet<string>,
  options: PathSearchOptions = DEFAULT_PATH_SEARCH_OPTIONS,
): Direction | null {
  if (position[0] === target[0] && position[1] === target[1]) return null;

  // ① 半径受限 BFS（首选）：局部绕行（敌群/墙）最短路径的第一步，确定性。
  const direction = stepTowardPath(position, target, obstacles, options);
  if (direction !== null) return direction;

  // ② 旧扩框长程 BFS（回退）：绕行点距起点 > 24 时兜底。地图无显式边界，
  // 逐级扩大搜索框；已知障碍视为永久阻塞，未知格允许探索。
  for (const margin of [4, 8, 16, 32] as const) {
    const direction = shortestPathFirstStep(position, target, obstacles, margin);
    if (direction !== null) return direction;
  }

  // ③ 极端情况下（目标被超长障碍完全包围）保持 fail-safe：只走一个不会撞墙、
  // 且**离目标更近**的格（横跳——在墙前左右移动不接近目标——浪费 tick 且
  // 敌群/障碍会移动，WAIT 让下一 tick 重新评估更优）；没有可接近的格则 WAIT。
  for (const direction of orderedDirections(position, target)) {
    const next = move(position, direction);
    if (obstacles.has(cellKey(next))) continue;
    if (manhattan(next, target) < manhattan(position, target)) return direction;
  }
  return null;
}

function shortestPathFirstStep(
  start: Position,
  target: Position,
  obstacles: ReadonlySet<string>,
  margin: number,
): Direction | null {
  const minX = Math.min(start[0], target[0]) - margin;
  const maxX = Math.max(start[0], target[0]) + margin;
  const minY = Math.min(start[1], target[1]) - margin;
  const maxY = Math.max(start[1], target[1]) + margin;
  const queue: Array<{ position: Position; firstDirection: Direction | null }> = [{ position: start, firstDirection: null }];
  const visited = new Set<string>([cellKey(start)]);
  let head = 0;

  while (head < queue.length && visited.size <= 20_000) {
    const current = queue[head++];
    for (const direction of orderedDirections(current.position, target)) {
      const next = move(current.position, direction);
      if (next[0] < minX || next[0] > maxX || next[1] < minY || next[1] > maxY) continue;
      const key = cellKey(next);
      if (visited.has(key) || obstacles.has(key)) continue;
      const firstDirection = current.firstDirection ?? direction;
      if (next[0] === target[0] && next[1] === target[1]) return firstDirection;
      visited.add(key);
      queue.push({ position: next, firstDirection });
    }
  }
  return null;
}

function orderedDirections(from: Position, target: Position): readonly Direction[] {
  const dx = target[0] - from[0];
  const dy = target[1] - from[1];
  const xDirection: Direction | null = dx === 0 ? null : dx > 0 ? "RIGHT" : "LEFT";
  const yDirection: Direction | null = dy === 0 ? null : dy > 0 ? "DOWN" : "UP";
  const preferred: Direction[] = [];
  if (Math.abs(dx) >= Math.abs(dy)) {
    if (xDirection !== null) preferred.push(xDirection);
    if (yDirection !== null) preferred.push(yDirection);
  } else {
    if (yDirection !== null) preferred.push(yDirection);
    if (xDirection !== null) preferred.push(xDirection);
  }
  for (const direction of DIRECTION_ORDER) {
    if (!preferred.includes(direction)) preferred.push(direction);
  }
  return preferred;
}

export function exploreTarget(
  home: Position,
  beacon: Position,
  index: number,
  radius: number,
): Position {
  const dx = beacon[0] - home[0];
  const dy = beacon[1] - home[1];
  const base = exploreOctant(dx, dy);
  const [mx, my] = EXPLORE_DELTAS[(base + index) % EXPLORE_DIRECTION_COUNT];
  return [home[0] + mx * radius, home[1] + my * radius];
}

function exploreOctant(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 0;
  const angle = Math.atan2(dy, dx);
  return (Math.round(angle / (Math.PI / 4)) + EXPLORE_DIRECTION_COUNT) % EXPLORE_DIRECTION_COUNT;
}

export function nearest(targets: Iterable<Position>, position: Position): Position | null {
  let best: Position | null = null;
  let bestKey: readonly [number, number, number] | null = null;
  for (const target of targets) {
    const key = [manhattan(position, target), target[0], target[1]] as const;
    if (bestKey === null || compareTuple(key, bestKey) < 0) {
      best = target;
      bestKey = key;
    }
  }
  return best;
}

export function move(position: Position, direction: Direction): Position {
  const [dx, dy] = DELTA[direction];
  return [position[0] + dx, position[1] + dy];
}

export function directionToAdjacent(from: Position, target: Position): Direction | null {
  const dx = target[0] - from[0];
  const dy = target[1] - from[1];
  if (Math.abs(dx) + Math.abs(dy) !== 1) return null;
  if (dx === 1) return "RIGHT";
  if (dx === -1) return "LEFT";
  if (dy === 1) return "DOWN";
  return "UP";
}

function compareTuple(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}
