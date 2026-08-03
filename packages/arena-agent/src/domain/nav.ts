import { cellKey, type Direction, type Position } from "./model.ts";

const DIRECTION_ORDER: readonly Direction[] = ["RIGHT", "DOWN", "LEFT", "UP"];
const DELTA: Readonly<Record<Direction, Position>> = {
  UP: [0, -1],
  DOWN: [0, 1],
  LEFT: [-1, 0],
  RIGHT: [1, 0],
};

export function manhattan(a: Position, b: Position): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
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

export function stepToward(
  position: Position,
  target: Position,
  obstacles: ReadonlySet<string>,
): Direction | null {
  if (position[0] === target[0] && position[1] === target[1]) return null;

  // 旧实现只看下一格：遇到墙时会在两个格之间来回摆动，永远无法绕到目标。
  // 这里做有界 BFS，直接返回一条最短路的第一步。地图无显式边界，因此逐级
  // 扩大搜索框；已知障碍视为永久阻塞，未知格允许探索。
  for (const margin of [4, 8, 16, 32] as const) {
    const direction = shortestPathFirstStep(position, target, obstacles, margin);
    if (direction !== null) return direction;
  }

  // 极端情况下（目标被超长障碍完全包围）保持 fail-safe：只走一个不会撞墙、
  // 且方向尽量朝向目标的格；若四周全堵则 WAIT。
  for (const direction of orderedDirections(position, target)) {
    if (!obstacles.has(cellKey(move(position, direction)))) return direction;
  }
  return null;
}

interface SearchNode {
  readonly position: Position;
  readonly firstDirection: Direction | null;
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
  const queue: SearchNode[] = [{ position: start, firstDirection: null }];
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
  const base = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : 2) : dy >= 0 ? 1 : 3;
  const direction = DIRECTION_ORDER[(base + index) % DIRECTION_ORDER.length];
  const [mx, my] = DELTA[direction];
  return [home[0] + mx * radius, home[1] + my * radius];
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
