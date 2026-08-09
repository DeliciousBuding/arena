/**
 * 迁移路径生成（migration-system-v1 §4，评审 P0-1 核心）。
 *
 * 职责：从起点到目标产出**实际可执行路径**——逐格推进的格子序列
 * （相邻格 Chebyshev 距离 ≤ 1，含对角），不是 waypoint 直线。
 * 计划 schema 的 path.cells 即由本函数产出。
 *
 * 设计决策：
 * - 无障碍时 = 单调超覆盖直线（对角优先），长度 = max(|dx|,|dy|)；
 * - 有障碍时用 8 邻域 A* 绕行：Chebyshev 启发一致可采纳 → 保证最优步数、
 *   确定性（邻居按"到目标距离 + 固定偏移序"排序，结果可复现）；
 * - 无界网格上"不可达"不可判定（有限障碍永远可绕行），因此不可达以
 *   起点/终点占用检查 + maxExpansions 搜索上限表征，不做无限搜索。
 */

import type { MigrationPosition } from "./plan.ts";

/** 障碍格 [x,y] 元组形态（与计划 schema path.cells 同构）。 */
export type RouteCell = readonly [number, number];

export type Obstacle = MigrationPosition | RouteCell;

export interface RouteOptions {
  /** A* 展开上限（默认 100_000）：无界网格上的终止保证。 */
  readonly maxExpansions?: number;
}

export type RouteResult =
  | { readonly ok: true; readonly path: readonly MigrationPosition[] }
  | { readonly ok: false; readonly reason: string };

/** 8 邻域偏移（顺序固定 → 同距候选按此序比较，保证确定性）。 */
const NEIGHBOR_OFFSETS: readonly (readonly [number, number])[] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

const chebyshev = (first: MigrationPosition, second: MigrationPosition): number =>
  Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y));

const cellKey = (x: number, y: number): string => `${x},${y}`;

/** 障碍两种形态（{x,y} 或 [x,y]）归一化为格点。 */
const toPoint = (obstacle: Obstacle): MigrationPosition => {
  if ("x" in obstacle) return obstacle;
  return { x: obstacle[0], y: obstacle[1] };
};

function parseKey(key: string): [number, number] {
  const comma = key.indexOf(",");
  const x = Number(key.slice(0, comma));
  const y = Number(key.slice(comma + 1));
  return [x, y];
}

interface HeapEntry {
  readonly f: number;
  readonly g: number;
  readonly seq: number;
  readonly key: string;
}

/** 最小堆：f 升序，同 f 按插入序（确定性）。 */
class MinHeap {
  private readonly items: HeapEntry[] = [];
  private seq = 0;

  get size(): number {
    return this.items.length;
  }

  push(g: number, f: number, key: string): void {
    const entry: HeapEntry = { g, f, key, seq: this.seq };
    this.seq += 1;
    this.items.push(entry);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.less(entry, this.items[parent]!)) {
        this.items[index] = this.items[parent]!;
        index = parent;
      } else {
        break;
      }
    }
    this.items[index] = entry;
  }

  pop(): HeapEntry | undefined {
    const top = this.items[0];
    if (top === undefined) return undefined;
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      let index = 0;
      for (;;) {
        const left = 2 * index + 1;
        if (left >= this.items.length) break;
        const right = left + 1;
        const child =
          right < this.items.length && this.less(this.items[right]!, this.items[left]!) ? right : left;
        if (this.less(this.items[child]!, last)) {
          this.items[index] = this.items[child]!;
          index = child;
        } else {
          break;
        }
      }
      this.items[index] = last;
    }
    return top;
  }

  private less(left: HeapEntry, right: HeapEntry): boolean {
    return left.f < right.f || (left.f === right.f && left.seq < right.seq);
  }
}

function reconstructPath(
  goalKey: string,
  cameFrom: ReadonlyMap<string, string>,
  from: MigrationPosition,
): MigrationPosition[] {
  const cells: MigrationPosition[] = [];
  let key: string | undefined = goalKey;
  while (key !== undefined) {
    const [x, y] = parseKey(key);
    cells.push({ x, y });
    if (x === from.x && y === from.y) break;
    key = cameFrom.get(key);
  }
  return cells.reverse();
}

export function planRoute(
  from: MigrationPosition,
  to: MigrationPosition,
  obstacles: readonly MigrationPosition[] | readonly RouteCell[],
  options: RouteOptions = {},
): RouteResult {
  const maxExpansions = options.maxExpansions ?? 100_000;

  const blocked = new Set<string>();
  for (const obstacle of obstacles) {
    const point = toPoint(obstacle);
    blocked.add(cellKey(point.x, point.y));
  }

  const startKey = cellKey(from.x, from.y);
  const goalKey = cellKey(to.x, to.y);
  if (blocked.has(startKey)) return { ok: false, reason: "起点格被障碍占用，无法出发" };
  if (blocked.has(goalKey)) return { ok: false, reason: "目标格被障碍占用，无法到达" };
  if (startKey === goalKey) return { ok: true, path: [{ x: from.x, y: from.y }] };

  const gScore = new Map<string, number>([[startKey, 0]]);
  const cameFrom = new Map<string, string>();
  const open = new MinHeap();
  open.push(0, chebyshev(from, to), startKey);

  let expansions = 0;
  while (open.size > 0) {
    const entry = open.pop()!;
    if (gScore.get(entry.key) !== entry.g) continue; // 已被更优路径取代的过期条目
    if (entry.key === goalKey) {
      return { ok: true, path: reconstructPath(entry.key, cameFrom, from) };
    }
    if (expansions >= maxExpansions) break;
    expansions += 1;

    const [x, y] = parseKey(entry.key);
    const candidates: { readonly point: MigrationPosition; readonly order: number }[] = [];
    for (let i = 0; i < NEIGHBOR_OFFSETS.length; i += 1) {
      const [dx, dy] = NEIGHBOR_OFFSETS[i]!;
      const point = { x: x + dx, y: y + dy };
      if (blocked.has(cellKey(point.x, point.y))) continue;
      // 对角步禁止穿角：两个正交中间格必须都可通行（引擎 4 向移动 +
      // overlay 对角分解走"先水平"轴，中间格被障碍占则分解第一步即被拒）。
      if (dx !== 0 && dy !== 0) {
        if (blocked.has(cellKey(x + dx, y)) || blocked.has(cellKey(x, y + dy))) continue;
      }
      candidates.push({ point, order: i });
    }
    // 邻居按"到目标 Chebyshev 距离"升序 → 无障碍时天然走直线，
    // 只有直线被堵才偏离绕行；同距按固定偏移序，结果可复现。
    candidates.sort(
      (first, second) =>
        chebyshev(first.point, to) - chebyshev(second.point, to) || first.order - second.order,
    );

    for (const { point } of candidates) {
      const candidateKey = cellKey(point.x, point.y);
      const tentativeG = entry.g + 1;
      const knownG = gScore.get(candidateKey);
      if (knownG === undefined || tentativeG < knownG) {
        gScore.set(candidateKey, tentativeG);
        cameFrom.set(candidateKey, entry.key);
        open.push(tentativeG, tentativeG + chebyshev(point, to), candidateKey);
      }
    }
  }

  return {
    ok: false,
    reason: `搜索 ${maxExpansions} 次展开未达目标（网格不可达或上限过小）`,
  };
}
