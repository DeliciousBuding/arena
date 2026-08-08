/**
 * 迁移路径生成测试（migration-system-v1 §8 验收）。
 *
 * 覆盖：无障碍逐格直线（含对角）、障碍绕行连通、不可达返回失败、
 * 路径合法性（相邻格 Chebyshev 恰好 1、无重复格）。
 *
 * 说明：无界网格上有限障碍永远可绕行，"不可达"无法用纯几何证明，
 * 因此不可达以"目标格被障碍占用"与"搜索上限未达"两个分支表征。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { planRoute } from "../src/migration/route.ts";
import type { RouteResult } from "../src/migration/route.ts";
import type { MigrationPosition } from "../src/migration/plan.ts";

const chebyshev = (first: MigrationPosition, second: MigrationPosition): number =>
  Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y));

function expectPath(result: RouteResult): readonly MigrationPosition[] {
  if (!result.ok) {
    assert.fail(`planRoute 失败: ${result.reason}`);
  }
  return result.path;
}

/** 路径合法性：首尾正确、逐格推进恰好 1 格（含对角）、无重复格。 */
function assertValidPath(
  path: readonly MigrationPosition[],
  from: MigrationPosition,
  to: MigrationPosition,
): void {
  assert.ok(path.length >= 1, "路径至少 1 格");
  assert.deepEqual(path[0], from, "路径首格应为起点");
  assert.deepEqual(path[path.length - 1], to, "路径末格应为目标");
  const seen = new Set<string>();
  for (let i = 0; i < path.length; i += 1) {
    const cell = path[i]!;
    const key = `${cell.x},${cell.y}`;
    assert.ok(!seen.has(key), `路径含重复格: ${key}`);
    seen.add(key);
    if (i > 0) {
      const previous = path[i - 1]!;
      assert.equal(
        chebyshev(previous, cell),
        1,
        `相邻格距应为 1（逐格推进）: ${JSON.stringify(previous)} → ${JSON.stringify(cell)}`,
      );
    }
  }
}

test("无障碍：逐格直线连通（含对角推进），长度 = max(|dx|,|dy|)+1", () => {
  const path = expectPath(planRoute({ x: 0, y: 0 }, { x: 5, y: 3 }, []));
  assert.equal(path.length, 6, "最优直线步数 = max(5,3) = 5 步");
  assertValidPath(path, { x: 0, y: 0 }, { x: 5, y: 3 });
  // 直线 = 单调推进（每步不远离目标），且包含对角步（dy 需 3 步覆盖）
  for (let i = 1; i < path.length; i += 1) {
    const dx = path[i]!.x - path[i - 1]!.x;
    const dy = path[i]!.y - path[i - 1]!.y;
    assert.ok(dx >= 0 && dy >= 0, `直线不应回退: 第 ${i} 步 (${dx},${dy})`);
  }
  const hasDiagonal = path.some(
    (cell, i) => i > 0 && cell.x !== path[i - 1]!.x && cell.y !== path[i - 1]!.y,
  );
  assert.ok(hasDiagonal, "直线应含对角步（曼哈顿折线，含对角）");
});

test("无障碍：纯轴向直线，无对角步", () => {
  const path = expectPath(planRoute({ x: 0, y: 0 }, { x: 0, y: 4 }, []));
  assert.equal(path.length, 5);
  assertValidPath(path, { x: 0, y: 0 }, { x: 0, y: 4 });
  for (let i = 1; i < path.length; i += 1) {
    assert.equal(path[i]!.x, 0, "纯轴向路径 x 不应变化");
    assert.equal(path[i]!.y - path[i - 1]!.y, 1, "每步应恰好 +1 格");
  }
});

test("起点即终点：单格路径", () => {
  const path = expectPath(planRoute({ x: 3, y: 3 }, { x: 3, y: 3 }, []));
  assert.deepEqual(path, [{ x: 3, y: 3 }]);
});

test("障碍绕行：短墙绕行，路径连通且避开障碍（最优 4 步）", () => {
  // (1,0),(2,0),(3,0) 三连墙：直线被堵，必须绕出 y=0（对角贴墙 4 步即 Chebyshev 最优）
  const path = expectPath(
    planRoute({ x: 0, y: 0 }, { x: 4, y: 0 }, [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]),
  );
  assertValidPath(path, { x: 0, y: 0 }, { x: 4, y: 0 });
  assert.equal(path.length, 5, "绕行 4 步 = Chebyshev 距离（步数下界，最优）");
  for (const cell of path) {
    assert.ok(!(cell.x >= 1 && cell.x <= 3 && cell.y === 0), `路径踩到障碍格: ${JSON.stringify(cell)}`);
  }
  assert.ok(path.some((cell) => Math.abs(cell.y) >= 1), "路径应确实绕出 y=0 直线");
});

test("障碍绕行：T 形障碍（前方与上下均堵）连通", () => {
  // 前 (1,0)、上 (1,1)、下 (1,-1) 全堵：必须绕到 y=±2 才过得去
  const path = expectPath(
    planRoute({ x: 0, y: 0 }, { x: 4, y: 0 }, [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: -1 }]),
  );
  assertValidPath(path, { x: 0, y: 0 }, { x: 4, y: 0 });
  assert.equal(path.length, 6, "绕过 T 形障碍最优 5 步");
  assert.ok(path.some((cell) => cell.x === 1 && Math.abs(cell.y) === 2), "必经 x=1 的 y=±2 缺口");
  for (const cell of path) {
    assert.ok(
      !(cell.x === 1 && cell.y >= -1 && cell.y <= 1),
      `路径踩到障碍格: ${JSON.stringify(cell)}`,
    );
  }
});

test("障碍绕行：直墙（竖向）绕行连通", () => {
  // (0,1),(0,2),(0,3)：直线北上被堵，从侧翼（x≠0）绕回
  const path = expectPath(
    planRoute({ x: 0, y: 0 }, { x: 0, y: 4 }, [{ x: 0, y: 1 }, { x: 0, y: 2 }, { x: 0, y: 3 }]),
  );
  assertValidPath(path, { x: 0, y: 0 }, { x: 0, y: 4 });
  assert.equal(path.length, 5, "绕行 4 步 = Chebyshev 距离（步数下界，最优）");
  assert.ok(path.some((cell) => cell.x !== 0), "路径应经侧翼绕行（x≠0 格）");
  for (const cell of path) {
    assert.ok(!(cell.x === 0 && cell.y >= 1 && cell.y <= 3), `路径踩到障碍格: ${JSON.stringify(cell)}`);
  }
});

test("障碍接受 [x,y] 元组形态（与计划 schema path.cells 同构）", () => {
  const obstacles: readonly (readonly [number, number])[] = [[1, 0], [2, 0], [3, 0]];
  const path = expectPath(planRoute({ x: 0, y: 0 }, { x: 4, y: 0 }, obstacles));
  assertValidPath(path, { x: 0, y: 0 }, { x: 4, y: 0 });
  assert.equal(path.length, 5);
  for (const cell of path) {
    assert.ok(!(cell.x >= 1 && cell.x <= 3 && cell.y === 0), `路径踩到障碍格: ${JSON.stringify(cell)}`);
  }
});

test("目标格被障碍占用 → 不可达失败", () => {
  const result = planRoute({ x: 0, y: 0 }, { x: 2, y: 0 }, [{ x: 2, y: 0 }]);
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("目标格"), `reason 应说明目标占用: ${result.reason}`);
});

test("起点格被障碍占用 → 失败", () => {
  const result = planRoute({ x: 0, y: 0 }, { x: 2, y: 0 }, [{ x: 0, y: 0 }]);
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("起点"), `reason 应说明起点占用: ${result.reason}`);
});

test("搜索上限内未达 → 不可达失败（无界网格终止保证）", () => {
  // 目标 Chebyshev 距离 80，上限 64 次展开必然不足 → 必须失败且 reason 说明上限
  const result = planRoute({ x: 0, y: 0 }, { x: 80, y: 80 }, [], { maxExpansions: 64 });
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("搜索"), `reason 应说明搜索上限: ${result.reason}`);
});

test("多组路径全部合法（相邻格距 ≤1，含障碍场景）", () => {
  const cases: { from: MigrationPosition; to: MigrationPosition; obstacles: MigrationPosition[] }[] = [
    { from: { x: -5, y: 3 }, to: { x: 12, y: -7 }, obstacles: [] },
    { from: { x: -5, y: 3 }, to: { x: 12, y: -7 }, obstacles: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: -1 }] },
    { from: { x: 10, y: 10 }, to: { x: -10, y: -10 }, obstacles: [] },
    { from: { x: 10, y: 10 }, to: { x: -10, y: -10 }, obstacles: [{ x: 0, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 1 }] },
  ];
  for (const { from, to, obstacles } of cases) {
    const path = expectPath(planRoute(from, to, obstacles));
    assertValidPath(path, from, to);
  }
});
