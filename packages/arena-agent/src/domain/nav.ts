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
  const dx = target[0] - position[0];
  const dy = target[1] - position[1];
  const primary: Direction[] = [];
  if (dx !== 0) primary.push(dx > 0 ? "RIGHT" : "LEFT");
  if (dy !== 0) primary.push(dy > 0 ? "DOWN" : "UP");

  for (const direction of primary) {
    if (!obstacles.has(cellKey(move(position, direction)))) return direction;
  }
  for (const direction of ["UP", "DOWN", "LEFT", "RIGHT"] as const) {
    if (primary.includes(direction)) continue;
    if (!obstacles.has(cellKey(move(position, direction)))) return direction;
  }
  return null;
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
