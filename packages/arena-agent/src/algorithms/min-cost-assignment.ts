/**
 * Rectangular Hungarian (Kuhn-Munkres) minimum-cost assignment — O(n³)。
 *
 * Input: cost matrix M[r][c] where columns ≥ rows (padding columns cost 0).
 * Output: assignment[rows] = column index or -1 (unassigned)。
 *
 * Pure function, deterministic, no I/O。
 * 最后更新：2026-08-08
 */

export function minimumCostAssignment(matrix: readonly (readonly number[])[]): readonly number[] {
  const rows = matrix.length;
  if (rows === 0) return [];
  const cols = Math.max(...matrix.map((row) => row.length), rows);
  if (cols === 0) return Array.from<number>({ length: rows }).fill(-1);

  // Clone into mutable working arrays, padding with 0-cost dummy columns.
  const cost: number[][] = [];
  for (let r = 0; r < rows; r += 1) {
    cost[r] = [];
    for (let c = 0; c < cols; c += 1) {
      cost[r]![c] = c < matrix[r]!.length ? matrix[r]![c]! : 0;
    }
  }

  const u = new Array<number>(rows + 1).fill(0);
  const v = new Array<number>(cols + 1).fill(0);
  const p = new Array<number>(cols + 1).fill(0);
  const way = new Array<number>(cols + 1).fill(0);

  for (let r = 1; r <= rows; r += 1) {
    p[0] = r;
    let j0 = 0;
    const minv = new Array<number>(cols + 1).fill(Number.POSITIVE_INFINITY);
    const used = new Array<boolean>(cols + 1).fill(false);
    let currentCol = 0;
    do {
      used[currentCol] = true;
      const i0 = p[currentCol]!;
      const rowCost = cost[i0 - 1]!;
      const ui = u[i0]!;
      let delta = Number.POSITIVE_INFINITY;
      let j1 = 0;
      for (let j = 1; j <= cols; j += 1) {
        if (used[j]) continue;
        const cur = rowCost[j - 1]! - ui - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = currentCol;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= cols; j += 1) {
        if (used[j]) {
          u[p[j]!]! += delta;
          v[j]! -= delta;
        } else {
          minv[j]! -= delta;
        }
      }
      currentCol = j1;
    } while (p[currentCol] !== 0);

    // Augmenting path
    do {
      const j1 = way[currentCol]!;
      p[currentCol] = p[j1]!;
      currentCol = j1;
    } while (currentCol !== 0);
  }

  // Extract assignment: p[col] = row
  const assignment = new Array<number>(rows).fill(-1);
  for (let j = 1; j <= cols; j += 1) {
    const row = p[j]!;
    if (row > 0 && row <= rows) {
      assignment[row - 1] = j - 1;
    }
  }

  return Object.freeze(assignment);
}
