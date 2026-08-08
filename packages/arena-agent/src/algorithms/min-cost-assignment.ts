/** Deterministic rectangular Hungarian assignment (rows <= columns).
 *
 * 生产回流（99b4ba2，production-runtime-v3 原样）：全局 worker→资源格分配的
 * 求解器——替代贪心在"局部最优≠全局最优"场景的短板（如 2 worker 抢近矿、
 * 远端矿没人去）。返回每行选中一列，总有限代价最小。经典 O(rows² × columns)
 * potential/slack 形式；等 slack 时取较低列索引，跨 run 输出稳定。
 *
 * 约束：矩阵必须矩形且 rows <= columns（worker 数 ≤ 资源格 + dummy 列）；
 * 所有代价必须有限——不可选组合用大哨兵值（调用方拼 forbid 列）而非 Infinity。
 */

export function minimumCostAssignment(costs: readonly (readonly number[])[]): readonly number[] {
  if (costs.length === 0) return [];
  const rows = costs.length;
  const cols = costs[0]!.length;
  if (cols < rows || costs.some((row) => row.length !== cols)) {
    throw new Error("assignment matrix must be rectangular with rows <= columns");
  }
  if (costs.some((row) => row.some((cost) => !Number.isFinite(cost)))) {
    throw new Error("assignment matrix costs must be finite");
  }

  // 1-indexed Hungarian arrays: u=row potential, v=column potential,
  // p=matched row for column, way=augmenting predecessor column.
  const u = new Array<number>(rows + 1).fill(0);
  const v = new Array<number>(cols + 1).fill(0);
  const p = new Array<number>(cols + 1).fill(0);
  const way = new Array<number>(cols + 1).fill(0);

  for (let i = 1; i <= rows; i += 1) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(cols + 1).fill(Number.POSITIVE_INFINITY);
    const used = new Array<boolean>(cols + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = Number.POSITIVE_INFINITY;
      let j1 = 0;
      for (let j = 1; j <= cols; j += 1) {
        if (used[j]) continue;
        const cur = costs[i0 - 1]![j - 1]! - u[i0]! - v[j]!;
        if (cur < minv[j]! - Number.EPSILON) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta - Number.EPSILON || (Math.abs(minv[j]! - delta) <= Number.EPSILON && j < j1)) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= cols; j += 1) {
        if (used[j]) {
          u[p[j]!] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0 !== 0);
  }

  const assignment = new Array<number>(rows).fill(-1);
  for (let j = 1; j <= cols; j += 1) {
    const row = p[j]!;
    if (row !== 0) assignment[row - 1] = j - 1;
  }
  if (assignment.some((column) => column < 0)) throw new Error("assignment incomplete");
  return assignment;
}
